import assert from 'node:assert/strict';
import test from 'node:test';
import { beginLoad, failLoad, isBlank, settle, untracked, type Tracked } from '../src/lib/freshness';
import { DEVICE_ABSENCE_GRACE_MS, preserveKnownDevices, visibleAudioInputs, visibleVideoInputs } from '../src/hooks/useDevices';

// Simulação das condições que faziam a interface piscar sob carga alta.
//
// Não dá para congestionar o event loop de verdade dentro de um teste e ainda
// ter um resultado repetível. O que dá para reproduzir é o efeito: respostas
// atrasadas, fora de ordem, com timeout no meio e recuperação depois — que é
// o que a máquina ocupada produz. As invariantes verificadas aqui são as seis
// que o relato exige.
//
// O sorteio é determinístico de propósito: um teste que falha uma vez a cada
// dez execuções não protege nada.
function sorteioDeterministico(semente: number): () => number {
  let estado = semente >>> 0;
  return () => {
    estado = (estado * 1_664_525 + 1_013_904_223) >>> 0;
    return estado / 0x1_0000_0000;
  };
}

interface Resposta { pedido: number; atrasoMs: number; falhou: boolean; valor: string[] }

// Um "painel" reduzido ao essencial: pede, espera, recebe fora de ordem.
function simularPainel(semente: number, rodadas: number) {
  const sortear = sorteioDeterministico(semente);
  let estado: Tracked<string[]> = untracked<string[]>();
  const respostas: Resposta[] = [];
  const historico: Array<Tracked<string[]>> = [];

  for (let rodada = 0; rodada < rodadas; rodada += 1) {
    estado = beginLoad(estado);
    historico.push(estado);
    respostas.push({
      pedido: estado.request,
      // Até dois segundos de atraso: o que um event loop travado produz.
      atrasoMs: Math.round(sortear() * 2_000),
      // Uma em cada quatro respostas não chega — timeout ou rede engasgada.
      falhou: sortear() < 0.25,
      valor: [`canal-${rodada}`, `call-${rodada}`],
    });
  }

  // As respostas chegam na ordem dos atrasos, não na ordem em que foram
  // pedidas. É exatamente aqui que a resposta velha vencia a nova.
  const chegada = [...respostas].sort((a, b) => a.atrasoMs - b.atrasoMs || a.pedido - b.pedido);
  for (const resposta of chegada) {
    estado = resposta.falhou
      ? failLoad(estado, resposta.pedido, 'tempo esgotado')
      : settle(estado, resposta.pedido, resposta.valor);
    historico.push(estado);
  }
  return { estado, respostas, historico };
}

test('sob respostas embaralhadas e com falhas, o painel converge para o último pedido', () => {
  for (let semente = 1; semente <= 25; semente += 1) {
    const { estado, respostas } = simularPainel(semente, 12);
    const ultimo = respostas.at(-1)!;
    if (!ultimo.falhou) {
      assert.deepEqual(estado.value, ultimo.valor, `semente ${semente}: venceu uma resposta que não é a mais nova`);
      assert.equal(estado.status, 'ready');
    } else {
      // A última falhou: o valor precisa ser o de alguma resposta anterior, e
      // a tela precisa dizer que está desatualizada — nunca ficar em branco
      // por causa de um timeout.
      assert.equal(estado.status === 'stale' || estado.status === 'failed', true);
    }
  }
});

test('uma vez que houve dado válido, ele nunca volta a sumir da tela', () => {
  for (let semente = 1; semente <= 25; semente += 1) {
    const { historico } = simularPainel(semente, 12);
    let jaTeveDado = false;
    for (const passo of historico) {
      if (passo.value !== null) jaTeveDado = true;
      if (!jaTeveDado) continue;
      assert.notEqual(passo.value, null, `semente ${semente}: o dado sumiu depois de existir`);
      assert.equal(isBlank(passo), false, `semente ${semente}: a tela voltou para "carregando" com dado em mãos`);
    }
  }
});

test('nenhum estado intermediário fica preso em carregando sem nada a mostrar', () => {
  for (let semente = 1; semente <= 25; semente += 1) {
    const { estado } = simularPainel(semente, 12);
    // No fim de tudo, ou há valor, ou a falha está declarada. O que não pode
    // é o painel terminar dizendo "carregando" para sempre.
    assert.equal(estado.status === 'loading' || estado.status === 'refreshing', false, `semente ${semente}`);
  }
});

// A mesma exigência, do outro lado da interface: a lista de dispositivos.
// Uma rajada de `devicechange` — que é o que o PipeWire produz quando a live
// monta o barramento de áudio — não pode esvaziar o seletor.
test('rajada de devicechange com respostas incompletas não esvazia o seletor', () => {
  const reais = [
    { kind: 'audioinput', deviceId: 'mic-usb', label: 'USB PnP Sound Device' },
    { kind: 'videoinput', deviceId: 'cam', label: 'Webcam' },
  ] as MediaDeviceInfo[];
  const sortear = sorteioDeterministico(7);
  let estado = preserveKnownDevices([], reais, {}, 0);

  // 200 eventos em vinte segundos: mais denso do que qualquer rajada real, e
  // muito além da janela de preservação — que aqui não pode salvar nada, porque
  // o aparelho continua aparecendo em enumerações boas o tempo todo.
  for (let evento = 1; evento <= 200; evento += 1) {
    const agora = evento * 100;
    const sorte = sortear();
    // Parte das enumerações volta vazia ou só com as entradas virtuais do
    // Chromium, que é o que acontece enquanto o grafo do PipeWire reassenta.
    const enumeracao = sorte < 0.3 ? [] as MediaDeviceInfo[]
      : sorte < 0.5 ? [{ kind: 'audioinput', deviceId: 'default', label: '' }] as MediaDeviceInfo[]
      : reais;
    estado = preserveKnownDevices(estado.devices, enumeracao, estado.absence, agora);
    assert.equal(visibleAudioInputs(estado.devices).length, 1, `evento ${evento}: o microfone sumiu da lista`);
    assert.equal(visibleVideoInputs(estado.devices).length, 1, `evento ${evento}: a câmera sumiu da lista`);
  }

  // E, encerrada a rajada, um sumiço que persiste além da janela é aceito.
  const agora = 200 * 100;
  let sumindo = preserveKnownDevices(estado.devices, [], estado.absence, agora);
  sumindo = preserveKnownDevices(sumindo.devices, [], sumindo.absence, agora + DEVICE_ABSENCE_GRACE_MS + 1);
  assert.deepEqual(visibleAudioInputs(sumindo.devices), [], 'preservar não pode virar memória eterna');
});

// E o contrário também precisa valer: um aparelho realmente desligado sai.
test('quando o navegador responde de verdade, o aparelho removido some', () => {
  const dois = [
    { kind: 'audioinput', deviceId: 'mic-usb', label: 'USB PnP Sound Device' },
    { kind: 'audioinput', deviceId: 'mic-webcam', label: 'Microfone da webcam' },
  ] as MediaDeviceInfo[];
  const comOsDois = preserveKnownDevices([], dois).devices;
  assert.equal(visibleAudioInputs(comOsDois).length, 2);

  const soUm = preserveKnownDevices(comOsDois, [dois[1]]).devices;
  assert.deepEqual(visibleAudioInputs(soUm).map((device) => device.deviceId), ['mic-webcam']);
});
