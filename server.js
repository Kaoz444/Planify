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

client.connect().then(() => {
  db = client.db('horoscopoDB');
  console.log('Conectado a MongoDB');
}).catch((error) => {
  console.error('Error conectando a MongoDB:', error);
});

// Endpoint para recibir mensajes
app.post('/webhook', async (req, res) => {
  console.log('Solicitud recibida en /webhook');
  const { Body, From } = req.body;

  if (!Body) {
    console.error('No se recibió mensaje');
    return res.status(400).send('Solicitud inválida');
  }

  let respuestaIA;

  try {
    // Verificar si el usuario existe
    let usuario = await db.collection('conversaciones').findOne({ usuario: From });

    if (!usuario) {
      console.log(`Nuevo usuario: ${From}`);
      // Crear nuevo usuario
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
        to: From,
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

        await twilioClient.messages.create({
          body: 'Has sido bloqueado debido a múltiples mensajes inapropiados.',
          from: 'whatsapp:+14782494542',
          to: From,
        });

        return res.status(200).send();
      }

      // Actualizar advertencias en la base de datos
      await db.collection('conversaciones').updateOne(
        { usuario: From },
        { $set: { advertencias: usuario.advertencias } }
      );

      await twilioClient.messages.create({
        body: `Advertencia: Tu mensaje no es relevante para el propósito de Planify. Tienes ${3 - usuario.advertencias} oportunidades restantes.`,
        from: 'whatsapp:+14782494542',
        to: From,
      });

      return res.status(200).send();
    }

    // Continuar con OpenAI si el mensaje es apropiado
    usuario.mensajes.push({ role: 'user', content: Body });

    const contexto = usuario.mensajes.slice(-10);
    const openaiResponse = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: contexto,
      max_tokens: 150,
    });

    respuestaIA = openaiResponse.choices[0].message.content.trim();
    usuario.mensajes.push({ role: 'assistant', content: respuestaIA });

    // Actualizar la conversación en la base de datos
    await db.collection('conversaciones').updateOne(
      { usuario: From },
      { $set: { mensajes: usuario.mensajes, ultimaActualizacion: new Date() } }
    );

    console.log('Respuesta de OpenAI:', respuestaIA);
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    respuestaIA = 'Hubo un error procesando tu solicitud.';
  }

  // Enviar respuesta por WhatsApp
  try {
    await twilioClient.messages.create({
      body: respuestaIA,
      from: 'whatsapp:+14782494542',
      to: From,
    });
  } catch (error) {
    console.error('Error enviando respuesta a WhatsApp:', error);
  }

  res.status(200).send();
});

// Iniciar servidor
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
