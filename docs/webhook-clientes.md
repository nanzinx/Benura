# Webhook de transferências da BenURA

A BenURA avisa um sistema cliente sempre que um operador é transferido da **URA para o Ativo** ou do **Ativo para a URA**. Isso vale para todos os casos: ociosidade, venda, URA cheia, "Alocar todos no Ativo", "Retomar rodízio" e movimentos à mão no painel. Os robôs não entram.

## 1. Cadastro (o cliente faz uma vez)

```http
POST http://<servidor-da-benura>:3000/webhooks/clientes
Authorization: Bearer <token da BenURA (WEBHOOK_TOKEN)>
Content-Type: application/json

{ "url": "https://seu-sistema.exemplo.com/benura/transferencias", "nome": "Nome do seu sistema" }
```

Resposta `201`:

```json
{ "id": "a1b2c3d4e5f6", "nome": "Nome do seu sistema", "url": "https://...", "criadoEm": "2026-10-30T11:00:00.000Z", "segredo": "64 caracteres hexadecimais" }
```

**Guarde o `segredo`.** Ele aparece só nessa resposta e serve para conferir que cada aviso veio da BenURA.

- A URL precisa ser `https`. `http` só é aceito para `localhost`.
- **Listar:** `GET /webhooks/clientes`. Mostra os cadastrados, sem o segredo.
- **Descadastrar:** `DELETE /webhooks/clientes?id=<id>`.
- **Mensagem de teste:** `POST /webhooks/clientes/testar` com `{ "id": "<id>" }`. Chega com `codigo: 0`.

Todas essas chamadas levam o mesmo `Authorization: Bearer`.

## 2. O aviso (a BenURA chama o cliente)

A cada transferência, a BenURA faz um `POST` na URL cadastrada com **exatamente** este corpo:

```json
{ "codigo": 1234, "nome": "Fulano de Tal", "mensagem": "Transferido da URA para o Ativo" }
```

| Campo | O que é |
| --- | --- |
| `codigo` | Código do usuário na Argus (`idUsuario`). Vem `null` se o diretório da Argus estiver fora do ar naquele momento. |
| `nome` | Nome do operador na Argus. Sem o diretório, vem "Ramal 1234". |
| `mensagem` | `"Transferido da URA para o Ativo"` ou `"Transferido do Ativo para a URA"`. |

Cabeçalho: `X-BenURA-Assinatura: sha256=<HMAC-SHA256 do corpo, com o segredo do cadastro>`.

- Responda com `2xx` em até 5 s.
- Em erro de rede ou `5xx`, a BenURA tenta mais uma vez. Depois disso, o aviso fica só no log dela.
- Os avisos não esperam uns pelos outros. Use a ordem de chegada só como referência.

## 3. Conferindo a assinatura (exemplo em Node)

```js
const crypto = require('crypto');
function veioDaBenura(corpoBruto, cabecalho, segredo) {
  const esperado = 'sha256=' + crypto.createHmac('sha256', segredo).update(corpoBruto).digest('hex');
  return cabecalho && crypto.timingSafeEqual(Buffer.from(cabecalho), Buffer.from(esperado));
}
```

Use o corpo **bruto**, exatamente como chegou, antes de converter para JSON.
