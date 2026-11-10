# Controle

Controle remoto pelo Wi-Fi para TV e TV box, aberto no navegador do celular. Sem anúncio,
sem loja e sem conta.

Funciona com:

| Aparelho | Situação |
| --- | --- |
| TV LG antiga (NetCast, 2012–2013) | testado numa TV de verdade |
| Fire TV Stick (Amazon) | testado num de verdade |
| Projetor / TV box Android com ADB por rede | testado num projetor de verdade |
| TV LG webOS (2014 em diante) | testado só com TV simulada |
| TV Samsung Tizen (2016 em diante) | testado só com TV simulada |

Se alguma coisa não funcionar na sua TV, abra uma *issue* aqui no GitHub contando o modelo dela.

---

## Como funciona (em 1 minuto)

```
celular (navegador)  ──Wi-Fi──>  computador da casa (a "ponte")  ──>  TV LG / TV Samsung
                                                                 └──>  Fire Stick / Android
```

O celular sozinho não consegue achar a TV na rede nem falar a "língua" dela pelo navegador.
Por isso um **computador da sua casa** roda um programinha (a **ponte**). O celular abre uma
página servida por esse computador, e a ponte repassa cada toque para a TV.

Por isso:

- O computador precisa estar **ligado** e na **mesma rede** (mesmo roteador) que a TV.
  Pode ser por cabo ou Wi-Fi.
- O celular precisa estar no **Wi-Fi de casa**. Fora de casa não funciona, e é de propósito:
  ninguém de fora consegue mexer na sua TV.
- As chaves de pareamento das TVs ficam **só no seu computador**. Nada vai para a internet.

---

## Passo 1 — Instalar o Node.js (uma vez só)

A ponte é escrita em JavaScript e precisa do **Node.js versão 20 ou mais nova**.

- **Windows e Mac:** entre em <https://nodejs.org>, baixe a versão **LTS** e instale
  clicando em "Avançar" até o fim.
- **Linux (Ubuntu/Debian):** `sudo apt install nodejs npm`. Se a versão for menor que 20
  (confira com `node -v`), instale pelo site acima.

Para conferir, abra um terminal (no Windows: menu Iniciar → digite **cmd** → Enter) e rode:

```bash
node -v
```

Deve aparecer algo como `v22.11.0`.

## Passo 2 — Baixar o Controle

**Jeito fácil:** nesta página do GitHub, clique no botão verde **Code** → **Download ZIP**.
Descompacte numa pasta fácil de achar, por exemplo `Documentos\controle`.

**Com git** (se você usa):

```bash
git clone https://github.com/igorsfugiwara/controle.git
```

## Passo 3 — Instalar e ligar a ponte

Abra o terminal **dentro da pasta do Controle**:

- **Windows:** abra a pasta no Explorador, clique na barra de endereço, digite `cmd` e Enter.
- **Mac:** clique com o botão direito na pasta → **Novo Terminal na Pasta**.
- **Linux:** clique com o botão direito na pasta → **Abrir no terminal**.

Rode, um de cada vez:

```bash
npm install
```

```bash
npm start
```

Vai aparecer uma linha assim:

```
Controle no ar: http://192.168.0.12:8787
```

Esse é o **endereço do controle**. Anote: é ele que você vai abrir no celular.

**Avisos que podem aparecer:**

- **Windows:** o Firewall pergunta se o Node.js pode usar a rede. Marque **Redes privadas**
  e clique em **Permitir acesso**. Se a rede da sua casa estiver como "Pública" no Windows,
  troque para "Privada" (Configurações → Rede e Internet → sua rede → Perfil de rede: Privada),
  senão a ponte não acha a TV.
- **Mac:** aparece "Deseja que o node aceite conexões de entrada?". Clique em **Permitir**.

Enquanto essa janela do terminal estiver aberta, o controle funciona. Para deixar ligado
sempre, veja o [Passo 6](#passo-6--deixar-ligado-sozinho).

## Passo 4 — Abrir no celular

1. Conecte o celular no **Wi-Fi de casa**.
2. No Chrome do celular, digite o endereço que apareceu, por exemplo `http://192.168.0.12:8787`.
3. Toque em **Procurar aparelhos**. A TV e o Fire precisam estar ligados.

**Ícone na tela inicial (Android):** no Chrome, toque nos **⋮** → **Adicionar à tela inicial**.
Se não achar no menu, role até o fim; em alguns celulares fica em **Compartilhar** →
**Adicionar à tela inicial**.

**iPhone:** no Safari, toque em **Compartilhar** → **Adicionar à Tela de Início**.

No topo da página há um botão de **tela cheia**, e a **engrenagem** abre a lista de aparelhos.

## Passo 5 — Primeira vez em cada aparelho

A ponte procura os aparelhos sozinha a cada 30 segundos. Se algum não aparecer, abra a
engrenagem → escolha o tipo → digite o IP do aparelho → **Adicionar**. O IP aparece nas
configurações de rede da TV ou na lista de aparelhos conectados do roteador.

### TV LG webOS (2014 em diante)

- Na primeira conexão aparece um aviso na TV pedindo permissão. Aceite com o controle da TV.
- **Para ligar a TV pelo celular:** na TV, Configurações → Geral → Dispositivos (ou Conexão) →
  ative **Ligar via Wi-Fi** / **LG Connect Apps**, e também **Quick Start+** se tiver. Depois
  ligue a TV uma vez com o controle conectado, para a ponte aprender o endereço físico dela.

### TV LG antiga (NetCast, 2012–2013)

- No celular aparece **Mostrar PIN na TV**. Toque, veja o número que aparece na TV e digite.
- Essas TVs **não ligam pela rede**: ligue no botão da TV (ou pelo Fire Stick, se ele estiver
  na TV). O resto funciona: volume, canais, números, entradas, cores, mídia e touchpad.

### TV Samsung (2016 em diante)

- Na primeira conexão a TV pergunta se permite o **Controle**. Escolha **Permitir**.
- **Para ligar a TV pelo celular:** Configurações → Geral → Rede → Configurações avançadas
  (ou Configurações de especialista) → ative **Ligar com dispositivo móvel**.
- **Botão voltar:** muitas Samsung ignoram o "voltar" dentro dos apps (Netflix, YouTube…)
  quando ele vem de app de controle. Aqui ele vai como apertar e soltar, do jeito do controle
  original. Se mesmo assim não voltar, abra a engrenagem e toque em **Voltar: modo 1** no
  cartão da TV para trocar para o modo 2.
- **Se a TV recusou** (alguém apertou "Negar"): na TV, Configurações → Geral → Gerenciador de
  dispositivos externos → Gerenciador de conexão de dispositivos → Lista de dispositivos →
  apague o "Controle" e toque em **Tentar de novo** no celular.

### Fire TV Stick

- No celular aparece **Mostrar PIN na TV**. Toque, veja o número na TV e digite. Pronto.
- Para **digitar**, abra antes a busca no Fire; escreva no celular e toque em **Enviar**.
- **Opcional (mais botões):** com a depuração ADB ligada aparecem também ajustes, guia, busca
  e legendas. No Fire: Configurações → Minha Fire TV → Sobre → clique 7 vezes no nome do
  aparelho → volte → Opções do desenvolvedor → **Depuração ADB** → Ativado. Na primeira
  conexão o Fire pergunta se permite: marque **Sempre permitir deste computador**. Precisa
  também do ADB no computador (veja abaixo).

### Projetor ou TV box Android

- Precisa da **depuração ADB por rede** ligada (muitos projetores genéricos já vêm assim).
  Se não vier: Configurações → Sobre → clique 7 vezes em **Número da versão** → volte →
  Opções do desenvolvedor → ative **Depuração USB** e **Depuração por rede/ADB pela rede**.
- Normalmente não aparece sozinho na busca: adicione pela engrenagem como
  **Android (projetor/TV box)**, com o IP dele.
- Precisa do **ADB no computador**:
  baixe o [Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)
  do Google, descompacte e:
  - **Linux/Mac:** coloque a pasta `platform-tools` em `~/.local/share/controle/`.
  - **Windows:** descompacte em `C:\platform-tools` e ligue a ponte com
    `set ADB=C:\platform-tools\adb.exe` antes do `npm start` (ou adicione a pasta ao PATH).

**Dica:** no roteador, reserve um IP fixo (reserva de DHCP) para o **computador**. Se o IP
dele mudar, o endereço do controle no celular muda junto. A ponte já acompanha sozinha a TV e o
Fire quando eles trocam de IP.

## Passo 6 — Deixar ligado sozinho

Assim você não precisa abrir o terminal toda vez que ligar o computador.

### Windows

1. Aperte **Win + R**, digite `shell:startup` e Enter. Abre uma pasta.
2. Em outra janela, abra a pasta do Controle → `deploy`.
3. Clique com o botão direito em `iniciar-windows.cmd` → **Mostrar mais opções** →
   **Criar atalho**, e arraste o atalho para a pasta do passo 1.

Toda vez que você entrar no Windows, a ponte abre minimizada na barra de tarefas.

### Mac

```bash
npm install -g pm2
pm2 start src/server.mjs --name controle
pm2 save
pm2 startup
```

O último comando mostra uma linha começando com `sudo`. Copie, cole e rode essa linha.

### Linux (systemd)

Dentro da pasta do Controle:

```bash
mkdir -p ~/.config/systemd/user
sed "s#^WorkingDirectory=.*#WorkingDirectory=$PWD#" deploy/controle.service > ~/.config/systemd/user/controle.service
systemctl --user daemon-reload
systemctl --user enable --now controle
loginctl enable-linger "$USER"
```

O último comando faz subir mesmo antes de alguém fazer login. Para ver o que está acontecendo:
`journalctl --user -u controle -f`.

## Atualizar

- **Baixou o ZIP:** baixe de novo, descompacte por cima e rode `npm install` outra vez.
- **Com git:** `git pull` e `npm install`.

Depois reinicie a ponte. Os aparelhos pareados continuam salvos.

---

## Problemas comuns

**O celular não abre a página.**
O celular está no Wi-Fi de casa (não no 4G nem na rede de convidados)? O terminal da ponte
está aberto? No Windows, o Firewall liberou o Node.js em **Redes privadas**?

**"Procurar aparelhos" não acha nada.**
A TV está ligada e na mesma rede? Muitos roteadores têm uma rede separada para convidados ou
para 5 GHz que não conversa com a outra: computador e TV precisam estar na mesma. Se não
achar mesmo, adicione pelo IP na engrenagem.

**A TV aparece, mas fica "Desconectado".**
TV desligada ou em standby profundo. Ligue no botão da TV. Na LG webOS e na Samsung, ative a
opção de ligar pela rede (Passo 5) para o botão vermelho do celular ligar a TV.

**Digitar não funciona.**
Abra antes o campo de texto na TV (a lupa da busca, por exemplo) e depois escreva no celular.

**Mudou o endereço do controle.**
O IP do computador mudou. Veja o novo na janela da ponte e reserve um IP fixo no roteador.

## Onde ficam os dados

Tudo fica no computador que roda a ponte, num arquivo **fora** desta pasta:

- Linux/Mac: `~/.config/controle/aparelhos.json`
- Windows: `C:\Users\SEU-USUARIO\.config\controle\aparelhos.json`

Lá estão os aparelhos e as chaves de pareamento. Apagar esse arquivo faz a ponte esquecer
tudo e parear de novo.

**Segurança:** qualquer pessoa no Wi-Fi da sua casa consegue abrir o controle. Para visitas,
use a rede de convidados do roteador. Nunca abra a porta 8787 no roteador para a internet.

---

## Para quem programa

- `src/server.mjs`: servidor HTTP e WebSocket (`/ws`), descoberta por SSDP a cada 30 s, roteia
  os comandos para os drivers.
- Um driver por marca em `src/` com `start()`, `stop()`, `run(action, args)` e `status`:
  `lg.mjs` (webOS, WebSocket 3001/3000), `netcast.mjs` (LG 2012–2013, HTTP/ROAP 8080),
  `samsung.mjs` (Tizen, WebSocket 8001/8002), `fire.mjs` (ADB 5555, e `fire-lightning.mjs`,
  o canal do app oficial da Amazon pareado por PIN), e o mesmo `fire.mjs` para Android via ADB.
- `public/`: a página do controle (HTML, CSS e JS puros, sem build).
- Porta: `PORT=8787` (padrão). Arquivo de aparelhos: `CONTROLE_CONFIG=/caminho/aparelhos.json`.
  ADB: `ADB=/caminho/adb`.

```bash
npm run dev   # reinicia sozinho a cada mudança
npm test      # sobe uma TV LG e uma TV Samsung falsas e confere pareamento, comandos, apps e texto
```

Faltam Android TV/Google TV sem ADB (protocolo de controle remoto do Google) e Roku
(HTTP 8060). A descoberta já identifica Roku.
