# Controle

Controle remoto da TV e do Fire Stick pelo Wi-Fi, sem anúncio e sem loja.

```
celular (página)  ──Wi-Fi──>  ponte no PC (Node)  ──>  TV LG (WebSocket 3001/3000)
                                                  └──>  Fire Stick (ADB 5555)
```

O celular não fala direto com a TV porque o navegador não consegue achar aparelhos na rede
nem falar ADB. A ponte faz isso e serve a página em `http://IP-DO-PC:8787`.

## Rodar

```bash
npm install
npm start
```

A ponte procura TVs e Fire Sticks sozinha (SSDP) a cada 30 s e guarda o que achou em
`~/.config/controle/aparelhos.json` (fora do git: tem a chave de pareamento da TV).

O ADB usado é o `platform-tools` oficial do Google em `~/.local/share/controle/platform-tools/`
(ou o `adb` do sistema, ou o caminho em `ADB=`).

### Subir sozinho com o PC

```bash
ln -sf "$PWD/deploy/controle.service" ~/.config/systemd/user/controle.service
systemctl --user daemon-reload
systemctl --user enable --now controle
loginctl enable-linger "$USER"   # sobe mesmo antes de fazer login
```

Logs: `journalctl --user -u controle -f`.

## Primeira vez em cada aparelho

- **TV LG:** na primeira conexão aparece um aviso na TV; aceite. Para ligar a TV pelo celular,
  ative em Configurações → Geral → Dispositivos “Ligar via Wi-Fi” / “LG Connect Apps”
  (e Quick Start+, se tiver).
- **Fire Stick:** Configurações → Minha Fire TV → Sobre → clique 7 vezes no nome do aparelho →
  volte → Opções do desenvolvedor → Depuração ADB → Ativado. Depois aceite “Sempre permitir
  deste computador”.

Reserve no roteador IPs fixos para o PC, a TV e o Fire. A ponte acompanha a TV e o Fire
se mudarem de IP, mas o link do celular depende do IP do PC.

## O que tem

- **Fire Stick:** direcional, OK, voltar, início (segure para o menu rápido), menu, ajustes,
  retroceder, play/pausa, avançar, volume e mudo (vão para a TV LG quando ela está conectada),
  guia, busca, legendas, teclado, atalhos dos apps instalados e entradas da TV.
- **TV LG:** liga/desliga (liga pela rede), entradas (HDMI etc.), volume, canal, mudo, números,
  direcional, OK, voltar, início, sair, botões coloridos, mídia, info, guia, apagar só a tela,
  apps, teclado e touchpad (cursor da Magic Remote).

## Testes

```bash
npm test
```

O teste sobe uma TV LG falsa e confere pareamento, comandos e o canal de teclas.

## Próximas marcas

Cada marca é um driver em `src/` com `start/stop/run(action, args)` e `status`. Faltam
Samsung (WebSocket 8001/8002), Android TV/Google TV (protocolo de controle remoto do Google)
e Roku (HTTP 8060). A descoberta já identifica Samsung e Roku.
