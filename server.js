const express = require('express');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();

// Middleware para procesar JSON y datos URL-encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configura Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = twilio(accountSid, authToken);

// Configura OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Configura MongoDB
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);
let db;

client.connect()
  .then(() => {
    db = client.db('horoscopoDB');
    console.log('Conectado a MongoDB');
  })
  .catch((error) => {
    console.error('Error conectando a MongoDB:', error);
  });

// Endpoint para recibir mensajes
app.post('/webhook', async (req, res) => {
  console.log('Solicitud recibida en /webhook');
  let { Body, From } = req.body;

  if (!Body) {
    console.error('No se recibió mensaje');
    return res.status(400).send('Solicitud inválida');
  }

  // Normalizar número de teléfono para asegurar formato correcto
  if (!From.startsWith('+')) {
    From = '+' + From.replace(/\s/g, '').replace('whatsapp:', '');
  }

  let respuestaIA;

  try {
    console.log(`Mensaje recibido de: ${From}, Contenido: ${Body}`);

    // Verificar si el usuario existe
    let usuario = await db.collection('conversaciones').findOne({ usuario: From });

    if (!usuario) {
      console.log(`Nuevo usuario detectado: ${From}`);
      usuario = {
        usuario: From,
        mensajes: [
          { role: 'system', content: 'Eres un asistente personal que organiza agendas y ayuda a gestionar eventos, citas y tareas.' },
        ],
        advertencias: 0,
        bloqueado: false,
        ultimaActualizacion: new Date(),
      };
      await db.collection('conversaciones').insertOne(usuario);
    }

    // Verificar si el usuario está bloqueado
    if (usuario.bloqueado) {
      console.log(`Usuario bloqueado: ${From}`);
      await twilioClient.messages.create({
        body: 'Tu acceso a Planify ha sido restringido debido al mal uso de la aplicación.',
        from: 'whatsapp:+14782494542',
        to: `whatsapp:${From}`,
      });
      return res.status(200).send();
    }

    // **Filtro inicial en el backend**
    const palabrasProhibidas = [
      "tonto", "estúpido", "idiota", "imbécil", "basura", "inútil", "maldito", "estúpida", "grosera", "qué asco",
      "sexo", "pornografía", "erótico", "nalgas", "pechos", "desnudo", "hacer el amor", "masturbación", "coger",
      "follar", "chupar", "pene", "vagina", "prostitución", "puta", "puto", "chismes", "memes", "temas prohibidos",
      "política", "religión", "cuéntame un chiste", "baila", "haz magia"
    ];

    const mensajeInapropiado = palabrasProhibidas.some((palabra) => Body.toLowerCase().includes(palabra));

    if (mensajeInapropiado) {
      usuario.advertencias += 1;

      if (usuario.advertencias >= 3) {
        usuario.bloqueado = true;
        await db.collection('conversaciones').updateOne(
          { usuario: From },
          { $set: { advertencias: usuario.advertencias, bloqueado: usuario.bloqueado } }
        );

        console.log(`Usuario bloqueado por mensajes inapropiados: ${From}`);
        await twilioClient.messages.create({
          body: 'Has sido bloqueado debido a múltiples mensajes inapropiados.',
          from: 'whatsapp:+14782494542',
          to: `whatsapp:${From}`,
        });

        return res.status(200).send();
      }

      await db.collection('conversaciones').updateOne(
        { usuario: From },
        { $set: { advertencias: usuario.advertencias } }
      );

      console.log(`Advertencia enviada a usuario: ${From}, advertencias restantes: ${3 - usuario.advertencias}`);
      await twilioClient.messages.create({
        body: `Advertencia: Tu mensaje no es relevante para el propósito de Planify. Tienes ${3 - usuario.advertencias} oportunidades restantes.`,
        from: 'whatsapp:+14782494542',
        to: `whatsapp:${From}`,
      });

      return res.status(200).send();
    }

    usuario.mensajes.push({ role: 'user', content: Body });

    const contexto = usuario.mensajes.slice(-10);
    const openaiResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: contexto,
      max_tokens: 150,
    });

    respuestaIA = openaiResponse.choices[0].message.content.trim();
    usuario.mensajes.push({ role: 'assistant', content: respuestaIA });

    await db.collection('conversaciones').updateOne(
      { usuario: From },
      { $set: { mensajes: usuario.mensajes, ultimaActualizacion: new Date() } }
    );

    console.log('Respuesta generada por OpenAI:', respuestaIA);
  } catch (error) {
    console.error('Error al procesar la solicitud:', error.message);
    respuestaIA = 'Hubo un error procesando tu solicitud.';
  }

  try {
    console.log(`Enviando mensaje a WhatsApp desde: whatsapp:+14782494542 hacia: whatsapp:${From}`);
    await twilioClient.messages.create({
      body: respuestaIA,
      from: 'whatsapp:+14782494542',
      to: `whatsapp:${From}`,
    });
  } catch (error) {
    console.error('Error enviando respuesta a WhatsApp:', error.message);
    console.error('Detalles del error:', error);
  }

  res.status(200).send();
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
