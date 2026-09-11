import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FIM, freePort } from './freePort';

// A faixa de portas destes testes.
//
// Este arquivo afirmava, em comentário, que 20.000–60.000 estava "fora do que o
// sistema entrega sozinho para portas efêmeras". No Linux o padrão é
// 32768–60999: dois terços das candidatas eram exatamente portas que o núcleo
// pode dar a qualquer conexão de saída.
//
// E entre conferir a porta e o servidor de teste ligá-la passa a inicialização
// de um processo Node com `tsx`, enquanto a suíte abre dezenas de conexões para
// 127.0.0.1. Uma delas recebia a porta reservada, o servidor encontrava
// `EADDRINUSE` e saía com código 1 — o "servidor encerrou (1)" intermitente do
// CI, sempre no arquivo que sobe mais servidores.
//
// A reserva entre processos não cobria isso: ela impede que outra suíte pegue a
// porta, não que o núcleo a entregue a um cliente.

function inicioDasEfemeras(): number | null {
  try {
    const [baixo] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    return Number.isInteger(baixo) ? baixo : null;
  } catch {
    return null;
  }
}

test('a faixa de teste termina antes de onde começam as efêmeras do sistema', { skip: inicioDasEfemeras() === null ? 'sem /proc/sys/net/ipv4/ip_local_port_range' : false }, () => {
  const baixo = inicioDasEfemeras()!;
  assert.ok(FIM < baixo, `a faixa vai até ${FIM} e as efêmeras começam em ${baixo}: elas não podem se encostar`);
});

test('nenhuma porta entregue cai na faixa efêmera do sistema', { skip: inicioDasEfemeras() === null ? 'sem /proc/sys/net/ipv4/ip_local_port_range' : false }, async () => {
  const baixo = inicioDasEfemeras()!;
  const portas = await Promise.all(Array.from({ length: 12 }, () => freePort()));
  for (const porta of portas) assert.ok(porta < baixo, `${porta} está dentro da faixa efêmera (a partir de ${baixo})`);
  assert.equal(new Set(portas).size, portas.length, 'e nenhuma se repete');
});
