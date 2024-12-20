$envContent = Get-Content .env | Where-Object { $_ -match "^GITHUB_TOKEN=" }
$githubToken = $envContent -replace "GITHUB_TOKEN=", ""
git remote set-url origin https://$githubToken@github.com/Kaoz444/Planify.git
