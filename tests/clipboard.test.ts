import assert from 'node:assert/strict';
import test from 'node:test';
import { copyText, type SelectableField } from '../src/lib/clipboard';

function fakeField(): SelectableField & { focused: number; selected: number; range: [number, number] | null } {
  return {
    focused: 0,
    selected: 0,
    range: null,
    focus() { this.focused += 1; },
    select() { this.selected += 1; },
    setSelectionRange(start: number, end: number) { this.range = [start, end]; },
  };
}

test('o caminho normal usa a área de transferência do navegador', async () => {
  const escrito: string[] = [];
  const copiado = await copyText('TUMA1.abc.def', fakeField(), {
    clipboard: { writeText: async (text) => { escrito.push(text); } },
    execCommand: () => { throw new Error('a reserva não deveria ser usada'); },
  });
  assert.equal(copiado, true);
  assert.deepEqual(escrito, ['TUMA1.abc.def']);
});

// Era este o defeito: sem a permissão `clipboard-sanitized-write` autorizada
// pelo processo principal, a promessa é rejeitada e o botão não fazia nada.
test('permissão negada cai na reserva, que seleciona o campo e copia', async () => {
  const field = fakeField();
  const comandos: string[] = [];
  const copiado = await copyText('TUMA1.abc.def', field, {
    clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } },
    execCommand: (command) => { comandos.push(command); return true; },
  });
  assert.equal(copiado, true);
  assert.deepEqual(comandos, ['copy']);
  assert.equal(field.focused, 1);
  assert.equal(field.selected, 1);
  assert.deepEqual(field.range, [0, 'TUMA1.abc.def'.length]);
});

test('sem área de transferência nenhuma, a reserva ainda resolve', async () => {
  const field = fakeField();
  assert.equal(await copyText('convite', field, { clipboard: undefined, execCommand: () => true }), true);
  assert.equal(field.selected, 1);
});

// Um botão de copiar que falha em silêncio é pior do que não existir: quem
// chama precisa saber para poder pedir Ctrl+C.
test('quando as duas formas falham, a resposta é honesta', async () => {
  const copiado = await copyText('convite', fakeField(), {
    clipboard: { writeText: async () => { throw new Error('negado'); } },
    execCommand: () => false,
  });
  assert.equal(copiado, false);
  assert.equal(await copyText('convite', null, { clipboard: undefined, execCommand: () => true }), false, 'sem campo não há o que selecionar');
  assert.equal(await copyText('', fakeField(), { clipboard: { writeText: async () => undefined } }), false);
});

test('um campo que lança na seleção não derruba quem chamou', async () => {
  const quebrado: SelectableField = {
    focus() { throw new Error('janela sem foco'); },
    select() { /* não chega aqui */ },
  };
  assert.equal(await copyText('convite', quebrado, { clipboard: undefined, execCommand: () => true }), false);
});
