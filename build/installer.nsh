; Regras de firewall do Tumacord.
;
; O aplicativo sobe um servidor de sinalização (TCP 3927) e responde à
; descoberta de calls na rede local (UDP 3928). Sem uma regra, o Windows
; Defender Firewall mostra o próprio aviso na primeira vez que o programa
; escuta — e, se a pessoa clicar em "Cancelar" por reflexo, a descoberta
; simplesmente para de funcionar sem nenhuma explicação depois.
;
; O que este script NÃO faz, de propósito:
;
;   - não desliga o firewall, nem mexe em perfil nenhum;
;   - não abre porta para o perfil Público. Conexão vinda da internet por
;     encaminhamento de porta chega pela interface da rede local, que o Windows
;     classifica como Privada ou de Domínio — o enlace direto continua
;     funcionando sem expor a máquina em uma rede de aeroporto;
;   - não abre a porta para "qualquer programa": as duas regras são presas ao
;     executável do Tumacord, então nada mais pode receber naquela porta;
;   - a descoberta fica limitada à própria sub-rede, que é o alcance que ela
;     tem de verdade.
;
; Tudo é desfeito na desinstalação.

!macro TumacordFirewallRule Name Protocol Port Extra
  ; A remoção antes da criação evita duplicar a regra quando a pessoa instala
  ; por cima de uma versão anterior.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${Name}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${Name}" dir=in action=allow protocol=${Protocol} localport=${Port} profile=private,domain program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes ${Extra}'
  Pop $0
!macroend

!macro customInstall
  DetailPrint "Liberando o Tumacord no Windows Defender Firewall (rede privada)..."
  !insertmacro TumacordFirewallRule "Tumacord - sinalizacao (TCP 3927)" TCP 3927 ""
  !insertmacro TumacordFirewallRule "Tumacord - descoberta na rede local (UDP 3928)" UDP 3928 "remoteip=LocalSubnet"
!macroend

!macro customUnInstall
  ; A desinstalação por atualização não chega aqui — o electron-builder só roda
  ; este bloco na remoção de verdade —, então as regras sobrevivem a um
  ; upgrade e desaparecem quando o aplicativo sai da máquina.
  DetailPrint "Removendo as regras de firewall do Tumacord..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Tumacord - sinalizacao (TCP 3927)"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Tumacord - descoberta na rede local (UDP 3928)"'
  Pop $0
!macroend
