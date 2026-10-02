# Anime Battle Online Mobile

Projeto pronto para ser hospedado como um único serviço Node.js. O mesmo endereço entrega o jogo e o WebSocket, então no celular basta abrir o link HTTPS.

## Hospedagem

### Render
1. Suba esta pasta para um repositório GitHub.
2. No Render, crie um Web Service a partir do repositório.
3. O `render.yaml` já define `npm install`, `npm start` e `/health`.
4. O endereço ficará parecido com `https://anime-battle-online.onrender.com`.
5. Abra esse endereço no celular. O cliente troca automaticamente para `wss://.../ws` quando estiver em HTTPS.

### Local
`npm install && npm start`
Depois abra `http://localhost:8080`.

## O que foi preparado
- Interface responsiva para telas pequenas.
- PWA instalável pelo navegador do celular.
- Jogo e servidor no mesmo domínio.
- WebSocket seguro automaticamente em HTTPS.
- Salas 1v1, código de 6 caracteres e reconexão por token.
- Servidor autoritativo para HP, dano e recargas.
- `/health` para monitoramento da hospedagem.
- Dockerfile e `render.yaml` incluídos.

## Observação
O projeto está pronto para hospedagem, mas um domínio público só passa a existir depois que alguém fizer o deploy em uma conta de hospedagem. Este pacote não cria uma conta externa nem publica o servidor sozinho.
