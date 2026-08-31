# Bot Diegola Promoções

O bot busca produtos elegíveis pela Open API da Shopee e publica no grupo no formato:

> 🛍️ Nome do produto
>
> 💥 Por R$ 00,00
> 🛒 Compre aqui 👉 link de afiliado
>
> ⚠️ Oferta sujeita à alteração de preço e estoque no site.

Ele usa a imagem devolvida pela Shopee, evita repetir produtos e guarda a lista de itens publicados localmente em `data/posted.json`.

## Antes de ligar

1. Crie um bot no `@BotFather` e guarde o token.
2. Adicione esse bot como administrador do grupo **Diegola Promoções**, com a permissão **Enviar mensagens**.
3. Copie `.env.example` para `.env` e preencha somente no seu computador: AppID, Secret da Shopee, token do bot e ID numérico do grupo.
4. Se as publicações forem para o tópico **Promoções imperdíveis**, preencha também `TELEGRAM_MESSAGE_THREAD_ID`.

## Executar

Use o Node.js 20+:

```powershell
node src/index.mjs --once
node src/index.mjs
```

O primeiro comando publica no máximo um ciclo; o segundo repete no intervalo configurado.

## Segurança

Não envie `SHOPEE_SECRET` ou `TELEGRAM_BOT_TOKEN` em chat. Não os coloque em arquivo público, GitHub ou print.
