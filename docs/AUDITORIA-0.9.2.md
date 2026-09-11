# Auditoria da 0.9.2

Estado conferido em `8c38547`, branch `release/bandeja-e-correcoes-v0.9.2`,
árvore limpa e idêntica ao remoto. Nenhum trabalho de terceiros pendente.

Este documento separa quatro coisas que costumam ser confundidas:

- **reproduzido** — executado aqui, com a evidência registrada;
- **confirmado no código** — o caminho está lido e a conclusão não depende
  de execução;
- **não revalidado** — não foi olhado nesta passagem, e por isso não é
  afirmado nem negado;
- **hipótese** — plausível e sem confirmação.

Nada abaixo é marcado como corrigido sem execução.

---

## 1. Defeitos reproduzidos e corrigidos na 0.9.3

### F — o arrasto virava um ponto

**Relato:** clicar deixava um ponto, arrastar não deixava linha.

**Reprodução.** Um arrasto de 240 px com 90 ms entre movimentos — o ritmo de
uma mão — produziu no servidor **uma operação, de um ponto**:

```
mesa "Arrasto isolado" — revisão 1
  rev 1  stroke pedaço=c6c9a160-ea0… traço=c6c9a160… pontos=1
```

O mesmo arrasto em laço apertado produzia 22 pontos. Essa diferença é a chave:
no laço, a confirmação do servidor não chega no meio do movimento.

**Causa.** `src/lib/boards.ts` guardava numa referência só duas coisas
diferentes: o traço que a mão está fazendo e o eco desenhado localmente
enquanto a confirmação não volta. Um efeito apagava essa referência assim que
o quadro confirmado alcançava o que já fora enviado — o que, numa rede local,
acontece em milissegundos, **no meio do arrasto**. A partir dali todo
`extendStroke` encontrava a referência vazia e desistia em silêncio.

**Correção.** As duas coisas passam a ser explícitas em `src/lib/boardDraft.ts`,
com uma regra: *enquanto a caneta estiver encostada, nada esquece o traço.*

**Verificação.** O mesmo arrasto, em quadro isolado, depois da correção:

```
"Prova final": 1 traço(s)
  14 pontos, x de 188 a 940
```

Mais seis casos em `tests/boardDraft.test.ts`, incluindo o arrasto inteiro com
uma confirmação entre cada movimento.

### G — não havia como excluir uma mesa

Existiam limpar, encerrar e arquivar; nenhum apagava a mesa. E o teto global
dizia *"Arquive alguma antes de criar outra"* enquanto continuava contando as
arquivadas — mandava a pessoa fazer algo que não resolvia.

**Correção.** `board:manage` ganhou `delete`, autorizado a quem gerencia,
gravado na hora (sem esperar a janela de coalescência) e anunciado a quem
enxerga o canal. A exclusão deixa uma **lápide** persistida: sem ela, quem
ainda tivesse o quadro na memória devolveria a mesa inteira na troca de host
do P2P. A mensagem do teto global passou a falar em excluir.

**Verificação.** Dois testes contra servidores reais — exclusão sobrevivendo a
reinício, recusa de entrada e de desenho depois dela, e recusa da devolução no
P2P — mais a conferência no aplicativo, com a mesa saindo da lista.

---

## 2. Pontos da auditoria antiga, revalidados no código atual

| Item | Estado | Evidência |
| --- | --- | --- |
| Replicação de mensagens com autoria vinda do cliente | **CONFIRMADO — corrigido na 0.9.4** | `replicatedMessageSchema` aceitava `author` do payload e `chat:sync:push` mesclava nos dois modos; a mesclagem passou a ser só do P2P |
| Limite de participantes salvo, mas não aplicado na entrada | **CONFIRMADO — corrigido na 0.9.4** | `userLimit` era validado e gravado no painel e `voice:join` não o consultava |
| Exclusão de canal ocupado deixando chamada órfã | **CONFIRMADO — corrigido na 0.9.4** | `DELETE /api/admin/channels/:id` não consultava `rooms`; agora tira as pessoas e avisa antes de apagar |
| Inventário de anexos excedendo o limite do pacote | **CONFIRMADO no contrato, sem efeito hoje** | o servidor responde `availableAttachmentIds()` sem teto e o esquema aceita no máximo 500; o cliente envia lista vazia (`src/lib/chatSync.ts`), então o limite não é atingido pelo caminho atual |
| Duplicação de áudio após recuperação parcial | NÃO REVALIDADO | — |
| Trocas rápidas de câmera aplicando dispositivo desatualizado | NÃO REVALIDADO | — |
| Eleições diferentes na saída normal e na queda do host | NÃO REVALIDADO | — |
| Credenciais TURN renovadas sem atualizar conexões | NÃO REVALIDADO | — |
| Falhas de escrita em disco sem tratamento | NÃO REVALIDADO | — |
| Cancelamento de download antes da resposta HTTP | NÃO REVALIDADO | — |
| Instalador Windows e elevação | NÃO REVALIDADO | — |
| Verificação de atualização do servidor com HTTPS nativo | NÃO REVALIDADO | — |

---

## 3. Matriz do que foi inspecionado

Só os subsistemas efetivamente lidos nesta passagem.

| Área | P2P | Dedicado | Onde |
| --- | --- | --- | --- |
| Mesa: ordenação e revisões | host da sessão | instalação | `server/whiteboards.ts` |
| Mesa: persistência | nenhuma, por decisão | arquivo do servidor | `saveBoardsNow` em `server/index.ts` |
| Mesa: exclusão | lápide em memória | lápide no arquivo | `tombstones` |
| Mesa: adoção na troca de host | aceita, com três recusas | sempre recusada | `board:adopt` |
| Capacidade anunciada | `boards`, `boardPersistence: false` | `boards`, `boardPersistence: true` | `/api/health` |
| Janela e bandeja | igual nos dois | igual nos dois | `desktop/tray-policy.cjs` |
| Downloads de atualização | igual nos dois | igual nos dois | `sweepDownloads` |

A mesa **não** depende de voz, de live nem de overlay em nenhum dos modos —
conferido no aplicativo, criando e desenhando sem entrar em call.

---

## 4. Primeira etapa recomendada

**Autoridade do dedicado sobre histórico e perfis** (Prioridade 1-B).

É o achado mais grave desta passagem e o único com consequência de segurança:
em uma instalação dedicada, qualquer conta autenticada pode empurrar mensagens
assinadas como outra pessoa, porque o autor vem do pacote e não da sessão.

Proposta mínima, sem redesenho: **no modo dedicado, não mesclar pacotes de
replicação** — a história ali já é do servidor, e aceitar o pacote serve
apenas para importar conversa de um grupo P2P para dentro do dedicado, que é
exatamente o que não deve acontecer. No P2P a replicação continua como está,
porque é ela que preserva o histórico na troca de host.

Critérios de aceitação: uma conta comum não consegue inserir mensagem
atribuída a outra; o histórico do dedicado continua chegando por `chat:history`;
a troca de host no P2P continua preservando as mensagens; e nenhum dado já
gravado é apagado pela mudança.

Depois dela, em ordem: limite de voz aplicado na entrada e canal apagado sem
deixar call órfã — ambos confirmados acima e de escopo pequeno.

**Atualização:** as três coisas acima foram entregues na 0.9.4, e a
**Prioridade 1-A** — isolamento do cache local por origem — na 0.9.5.

A próxima etapa recomendada passa a ser a **Prioridade 1-C/D/E**: credenciais e
chave do servidor separadas por destino, e convite que resolve o destino antes
de escolher a autenticação. Depois dela, a **Prioridade 2-I**, a live por
escolha explícita.
