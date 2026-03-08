# wa-kommo-proxy

Projeto simples para Vercel que:
- recebe webhook do WhatsApp Cloud API
- repassa o payload bruto para o Woll-AI
- cria/acha contato no Kommo
- cria lead no Kommo
- salva mensagem/status como nota

## Variáveis de ambiente

- WOLL_WEBHOOK_URL
- WOLL_VERIFY_TOKEN
- META_VERIFY_TOKEN
- META_APP_SECRET
- KOMMO_SUBDOMAIN
- KOMMO_LONG_LIVED_TOKEN
- KOMMO_PIPELINE_ID
- KOMMO_STATUS_ID

## URL do webhook

Depois do deploy:

`https://SEU-DOMINIO/api/webhook`

## Meta

- Callback URL: `https://SEU-DOMINIO/api/webhook`
- Verify Token: valor de `META_VERIFY_TOKEN`
