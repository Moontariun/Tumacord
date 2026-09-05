// Copiar texto de dentro do Electron.
//
// `navigator.clipboard.writeText` depende da permissão
// `clipboard-sanitized-write`, que o processo principal precisa autorizar. Ela
// ficou de fora da lista até a 0.7.10 e o botão de copiar o convite não fazia
// nada. Autorizar resolve o caso normal, mas a promessa ainda pode ser
// rejeitada — janela sem foco, política do sistema — e um botão de copiar que
// falha em silêncio é pior do que não existir.
//
// Daí a reserva: selecionar o próprio campo e pedir a cópia pelo caminho
// antigo, que não passa por permissão nenhuma.

export interface SelectableField {
  focus: () => void;
  select: () => void;
  setSelectionRange?: (start: number, end: number) => void;
  value?: string;
}

export interface CopyDependencies {
  clipboard?: { writeText: (text: string) => Promise<void> } | undefined;
  execCommand?: (command: string) => boolean;
}

export async function copyText(text: string, field?: SelectableField | null, dependencies: CopyDependencies = {}): Promise<boolean> {
  if (!text) return false;
  const clipboard = 'clipboard' in dependencies ? dependencies.clipboard : globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Cai na reserva abaixo.
    }
  }
  if (!field) return false;
  const execCommand = dependencies.execCommand
    ?? (typeof document !== 'undefined' ? (command: string) => document.execCommand(command) : undefined);
  if (!execCommand) return false;
  try {
    field.focus();
    field.select();
    field.setSelectionRange?.(0, text.length);
    return execCommand('copy');
  } catch {
    return false;
  }
}
