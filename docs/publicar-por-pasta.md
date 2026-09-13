# Publicar largando o arquivo numa pasta

Desde a 0.13.0, publicar uma versão é copiar o pacote para uma pasta da VPS. O
serviço vê, confere, assina e passa a oferecer — sem comando nenhum.

---

## As duas pastas

Dentro do armazenamento de pacotes (`/pacotes` no contêiner):

```
/pacotes/linux/      tumacord-0.13.0.tar.gz
                     Tumacord-0.13.0.AppImage
/pacotes/windows/    Tumacord-0.13.0-Setup.exe
                     Tumacord-0.13.0-portable.exe
```

**Não há convenção nova a decorar.** São exatamente os nomes que o
`electron-builder` produz — o que sai de `npm run package:linux` e
`npm run package:windows` já está certo.

| Pasta | Arquivo | Para quem |
|---|---|---|
| `linux/` | `tumacord-<versão>.tar.gz` | instalação pelo script |
| `linux/` | `Tumacord-<versão>.AppImage` | AppImage |
| `windows/` | `Tumacord-<versão>-Setup.exe` | instalador |
| `windows/` | `Tumacord-<versão>-portable.exe` | portátil |

A versão sai do **nome do arquivo**, e de mais nada. Um nome fora do padrão é
ignorado e o motivo aparece no log:

```bash
docker logs tumacord-updates 2>&1 | grep scan-ignored
```

Isso é de propósito: um arquivo com nome torto virando "versão 0.1" seria pior
do que ele não aparecer.

---

## O ciclo inteiro

```bash
# 1. compilar (na sua máquina)
npm run package:linux

# 2. largar o arquivo (por rsync, scp, FTP, wget — tanto faz)
rsync -av release/tumacord-0.13.0.tar.gz vps:/var/lib/docker/volumes/tumacord_tumacord-pacotes/_data/linux/
```

Acabou. Em até um minuto o serviço varre, publica, e os aplicativos passam a
oferecer a versão. Quem não quiser esperar:

```bash
ssh vps "curl -fsS -X POST http://127.0.0.1:4301/admin/scan"
```

**Conferir o que ele viu:**

```bash
ssh vps "curl -fsS http://127.0.0.1:4300/v1/health"
```

`"publish":"folder"` diz que a pasta está no comando. `"publish":"imported"`
diz que ele está no modo antigo, servindo o que alguém importou.

---

## Tirar uma versão do ar

Apague o arquivo. A próxima varredura republica sem ela, e ninguém mais a
recebe. Quem já baixou continua com o que baixou — o que sai é a oferta.

---

## Versões antigas

Todas as versões da pasta entram no catálogo, e não só a mais nova. No
aplicativo, o interruptor **Mostrar versões antigas** (em Atualizações) lista
tudo e deixa instalar uma anterior.

A procura automática **nunca** oferece uma versão abaixo da instalada. Voltar
atrás é sempre um clique numa lista — uma decisão, e não algo que acontece
sozinho ao abrir o aplicativo.

---

## As chaves, e o que muda por elas estarem aqui

O serviço só publica sozinho se encontrar as chaves:

```
$TUMACORD_UPDATES_SIGNING_DIR/manifest.json
$TUMACORD_UPDATES_SIGNING_DIR/catalog.json
```

São os mesmos arquivos que `publish.mjs keys generate` produz — a pasta de
publicação de quem já tinha uma é copiada tal como está. Trocar de chave
obrigaria todo aplicativo instalado a atualizar antes de conseguir atualizar.

> **O que isto custa.** Antes da 0.13.0 a chave vivia fora do servidor, e
> invadir a VPS permitia servir arquivos mas **não** entregá-los como oficiais.
> Agora permite.
>
> Não há desvio: ou alguém assina no momento de largar o arquivo, ou quem
> assina é o servidor. "Largar o arquivo e pronto" escolhe o segundo.
>
> A assinatura continua valendo para o caminho entre o servidor e o aplicativo
> — um proxy trocado, um espelho, um DNS sequestrado continuam sem conseguir
> entregar nada. O que ela deixou de proteger é o servidor contra si mesmo.
>
> Quem preferir o contrário: apague `TUMACORD_UPDATES_SIGNING_DIR` do ambiente.
> O serviço volta a servir só o que for importado por
> [Publicação privada](publicacao-privada.md), e as chaves saem da máquina.

**Permissões:** a pasta em `700` e os arquivos em `600`, do usuário que roda o
contêiner. Uma chave privada legível por qualquer processo da máquina é uma
chave que já vazou.

---

## Quando algo não aparece

| Sintoma | Causa provável |
|---|---|
| o arquivo está lá e a versão não aparece | nome fora do padrão — veja `scan-ignored` no log |
| `"publish":"imported"` na saúde | sem chaves em `TUMACORD_UPDATES_SIGNING_DIR` |
| a versão aparece e o botão não deixa aplicar | não há pacote daquele formato para aquela máquina |
| duas versões some do ar | dois arquivos para o mesmo alvo — veja `scan-conflict` no log |
| o app não vê nada, mas o `curl` vê | o app pode estar sem origem configurada; desde a 0.12.2 ela vem embutida |
