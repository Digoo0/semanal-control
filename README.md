# Semana

Controle financeiro pessoal em português, com HTML, CSS e JavaScript puro, sem framework. Firebase instalado via npm para autenticação e sincronização; esbuild gera arquivos estáticos e remove código não utilizado. A interface local não carrega o SDK até você acessar sua conta.

## Rodar

```sh
git clone https://github.com/Digoo0/semanal-control.git
cd semanal-control
npm install
npm start
```

Requer Node.js 22 ou superior. Abra http://localhost:4173. No PowerShell com scripts bloqueados, use `npm.cmd` no lugar de `npm`. Para os testes: `npm test`. `npm run build` gera `dist/`; `npm run preview` serve o build existente. Após mudar os arquivos de `src/`, execute `npm start` novamente ou refaça o build.

Há também um teste de interface opcional em `tests/browser-smoke.mjs`: requer o servidor local e uma instância isolada do Chrome com depuração na porta 9224. Ele usa e limpa o armazenamento dessa instância de teste; não o execute no seu perfil pessoal.

## Como o saldo funciona

- O saldo inicial representa o dinheiro que você já tem ao começar, sem duplicar esse valor como uma entrada.
- O saldo é dividido igualmente pelas semanas até o próximo recebimento. Semanas começam na segunda-feira; a primeira e a última podem ser parciais e recebem uma parte igual.
- Uma saída desconta somente da semana em que ocorreu. Uma entrada redistribui o saldo total entre as semanas restantes.
- Na segunda-feira seguinte, todo o saldo que restou é dividido novamente. O cálculo é reconstruído pelo histórico mesmo que você fique dias sem abrir a aplicação.
- R$ 400 em quatro semanas → R$ 100 por semana. Gasto de R$ 50 → R$ 50 / R$ 100 / R$ 100 / R$ 100. Na semana seguinte → R$ 116,67 / R$ 116,67 / R$ 116,66.
- Centavos são inteiros; o excedente de arredondamento vai para as primeiras semanas.
- O limite da semana pode ficar negativo. Um saldo total negativo não gera reservas positivas após redistribuir.
- O recebimento previsto é o primeiro dia de segunda a sexta do mês. Feriados **não são consultados automaticamente**: ajuste a data em Configurações. No Brasil, 02/11/2026 é um exemplo de ajuste necessário; informe a data em que seu pagamento realmente cairá.
- O recebimento previsto não cria uma entrada automática. Registre seu salário quando ele cair.
- Não há agendamentos futuros. Entradas e saídas representam valores já recebidos ou pagos. Edições e exclusões recalculam o histórico.
- Os totais de entradas e saídas são do mês civil atual; o saldo disponível inclui todo o histórico.

## Armazenamento local e backup

Por padrão os dados ficam em `localStorage` no navegador, separados por domínio e dispositivo. Exporte backups em JSON para transferir ou preservar dados. Limpar os dados do navegador remove o histórico local. Importar um backup substitui o histórico após confirmação e exporta uma cópia dos dados anteriores.

## Firebase: semanal-control

O pacote `firebase` foi instalado via npm. Sua configuração web está em `src/firebase-config.js`; `src/firebase.js` inicializa o app com `initializeApp` de `firebase/app`. O módulo `src/cloud.js` usa Firebase Authentication (e-mail/senha) e Cloud Firestore Lite, que atende às leituras e transações desta versão com menos código que o SDK completo. Nenhuma configuração precisa ser colada na interface.

Antes do primeiro acesso à nuvem, confira no [console do projeto](https://console.firebase.google.com/project/semanal-control/overview):

1. Em Authentication → Sign-in method, habilite **E-mail/senha**.
2. Em Authentication → Settings → Authorized domains, adicione `localhost` para testes e o domínio em que você publicar, como `seu-usuario.github.io` para GitHub Pages.
3. Crie um banco **Cloud Firestore padrão** e publique o conteúdo de `firestore.rules` na aba Regras. Ele permite acesso apenas ao UID do proprietário e valida o incremento da revisão de cada gravação. O arquivo `.firebaserc` já associa este projeto ao `semanal-control`, caso você prefira publicar somente as regras com o Firebase CLI (`firebase deploy --only firestore:rules`).
4. Na aplicação, abra Configurações → Conectar ao Firebase. Informe e-mail e senha e marque a opção de criar conta se necessário.

Essas opções do console ainda precisam ser conferidas na sua conta. A instalação local não habilita Authentication, cria o banco ou publica regras automaticamente.

Se a conta estiver vazia, os dados locais são enviados. Se já tiver dados, eles são carregados e uma cópia do saldo local é baixada antes da troca. Sair da conta retorna ao histórico local anterior, que fica separado dos dados da nuvem. A senha não é gravada pela aplicação; a sessão do Firebase permanece na aba/sessão do navegador. O modo nuvem requer conexão para carregar e salvar. Falhas aparecem na interface e não são apresentadas como salvamentos bem-sucedidos.

As gravações usam transação e número de revisão: uma aba desatualizada não sobrescreve mudanças de outro dispositivo. Recarregue para buscar a versão atual. Não há sincronização de alterações em tempo real entre abas.

Para manter esta primeira versão simples, o histórico de cada usuário está em um documento (`users/{uid}/finance/budget`), sujeito ao limite de 1 MiB do Firestore. Para uso prolongado com muitos lançamentos, o próximo passo é separar os lançamentos em uma subcoleção e guardar resumos por ciclo. O cálculo local aceita até 10.000 lançamentos.

Configuração e referência oficiais: [SDK Web](https://firebase.google.com/docs/web/setup), [persistência de autenticação](https://firebase.google.com/docs/auth/web/auth-state-persistence), [regras de acesso por usuário](https://firebase.google.com/docs/rules/basics), [transações](https://firebase.google.com/docs/firestore/manage-data/transactions).

## GitHub e publicação

Tudo fica neste projeto local. Não há configuração de hospedagem do ChatGPT ou envio automático para repositórios.

O repositório é [Digoo0/semanal-control](https://github.com/Digoo0/semanal-control). A raiz contém `src/`, `scripts/`, `tests/`, `package.json` e `package-lock.json`. O `.gitignore` exclui dependências, cache e arquivos gerados.

Se quiser disponibilizar o sistema no **GitHub Pages**, o processo de publicação deve executar `npm ci` e `npm run build`, e publicar somente o conteúdo de `dist/` como artefato do Pages. Os caminhos são relativos, compatíveis com `https://seu-usuario.github.io/seu-repositorio/`. Apenas enviar o código para um repositório não habilita o Pages. O backend continua sendo seu projeto Firebase.

`firebase.json` configura apenas as regras do Firestore. Não há publicação automática no Firebase Hosting. A configuração web do Firebase é usada no navegador; o isolamento dos dados depende das regras e do login. Não adicione arquivos de conta de serviço ao repositório ou front-end.

## Estrutura

- `src/budget.js`: datas, períodos, validação e regras financeiras, sem DOM.
- `src/app.js`: interface e persistência local.
- `src/firebase-config.js`: configuração web do projeto `semanal-control`.
- `src/firebase.js`: inicialização do app via pacote npm.
- `src/cloud.js`: integração com Authentication e Firestore.
- `scripts/build.mjs`: build estático, com SDK carregado sob demanda.
- `dist/`: arquivos gerados prontos para hospedagem estática.
- `tests/budget.test.mjs`: testes do cálculo em centavos, datas e histórico.
- `server.mjs`: servidor estático local.

O visual usa fontes do sistema e funciona localmente sem acessar a nuvem. O SDK Firebase é incluído no build e não depende de imports de uma CDN. O login e as gravações precisam ser validados depois de habilitar os serviços e publicar as regras no seu projeto.
