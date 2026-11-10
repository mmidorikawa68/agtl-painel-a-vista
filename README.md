# Painel AGTL

Portal Node.js para gestão à vista com dashboards em carrossel e consulta à API do Porto. A importação de XML roda em um processo separado na rede local, grava no PostgreSQL local `agtl_painel_a_vista` e gera JSONs anuais para os dashboards.

## Arquitetura e configuração

Os processos são independentes:

- **Render (web):** executa `server.js`, serve as páginas, consulta a API do Porto e lê os JSONs anuais publicados no projeto. Não precisa acessar o PostgreSQL.
- **Computador local (importador):** executa `import-descargas.js`, lê `\\srvportal` e grava as descargas no banco local `agtl_painel_a_vista`. Precisa permanecer ligado para importar arquivos novos.

Os arquivos de descargas ficam em `public/data/descarga_por_turno_<ano>.json` e são entregues ao dashboard pela API autenticada. Depois de gerar ou atualizar um arquivo, publique-o junto com um novo deploy do Render para que os dashboards recebam os dados mais recentes.

Requisitos: Node.js 18 ou superior. Execute `npm install` em cada ambiente.

### Render: servidor web

Configure o Web Service para executar `npm start` e cadastre as variáveis no painel do Render:

| Variável | Valor |
| --- | --- |
| `DASHBOARD_API_URL` | URL completa da API da fila do Porto, incluindo os parâmetros/chave necessários |
| `DASHBOARD_API_TOKEN` | Token Bearer, somente se a API exigir |
| `SESSION_SECRET` | Segredo aleatório com pelo menos 32 bytes para assinar sessões temporárias |
| `USERS_FILE` | Caminho do arquivo de usuários provisionado no servidor (opcional; padrão `usuarios.json`) |

O Render fornece `PORT` automaticamente. O servidor web não usa conexão PostgreSQL.

O servidor exige login por e-mail e senha, mantém a sessão em cookie `HttpOnly` com validade de 8 horas e verifica se o usuário continua habilitado em cada requisição protegida. O cookie também usa `Secure` exceto quando `NODE_ENV=development`. O arquivo indicado por `USERS_FILE` deve conter uma lista JSON de usuários com `Nome`, `Email`, `Senha` (hash bcrypt) e `Status` (`Ativo` ou `Habilitado`). Esse arquivo é ignorado pelo Git e não é enviado automaticamente ao Render; provisione-o como arquivo secreto/persistente e configure `USERS_FILE` com o caminho correspondente. Gere `SESSION_SECRET` com um valor aleatório diferente para cada ambiente (por exemplo, `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) e mantenha-o apenas na configuração do servidor.

### Computador local: importador

O importador usa por padrão `localhost:5432`, o banco `agtl_painel_a_vista` e o usuário `postgres`. Configure as variáveis `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` e `PGPASSWORD` se a instalação local usar outros valores:

```powershell
$env:PGHOST = "localhost"
$env:PGDATABASE = "agtl_painel_a_vista"
$env:PGUSER = "postgres"
$env:PGPASSWORD = "senha-local"
$env:XML_BASE_PATH = "\\srvportal"
npm run import:descargas
```

O processo importa imediatamente e repete a varredura a cada 15 minutos. A máquina precisa acessar as pastas `\\srvportal\AAAA\MM\DD\SendRest` e o PostgreSQL local. Os eventos do importador são registrados com data e hora de São Paulo; se a pasta anual não puder ser acessada, o log informa o caminho e orienta verificar a disponibilidade e as permissões do compartilhamento, com nova tentativa no próximo ciclo.

A tabela `descargas`, sua sequência e `painel_importacao_controle` devem existir no banco. O controle contém `fonte` e `ultima_data_processada`, com as fontes `descargas_reconciliacao_inicial` (data inicial) e `descargas` (checkpoint do JSON). O usuário do importador precisa de leitura e gravação em `descargas`, leitura em `ncm` e `turnodescarga`, permissão para atualizar a sequência de `descargas.iddescarga` e leitura/gravação no controle. No início de cada varredura, o importador compara a sequência com o maior `iddescarga` e a avança se estiver atrasada. A cada ciclo, varre os XMLs desde 01/01/2026, considera nomes `SendRest_<idcarga>.xml`, ignora o ID `381006` e verifica o ID em `descargas` antes de inserir, sem exigir que as datas do XML coincidam com a pasta. Cargas com `cnpjexportador` vazio são relidas para tentar preencher esse campo. Falhas de leitura ou XML são registradas e permitem nova tentativa no próximo ciclo. O limite é 10 MB por arquivo.

Após cada varredura, o importador gera `public/data/descarga_por_turno_<ano>.json`. Usa o checkpoint para recalcular apenas os dias desde a última data processada; ao inserir uma descarga histórica ou preencher seu CNPJ, recua o checkpoint até a data operacional afetada e refaz os totais desde esse dia. A atualização do arquivo é atômica e o checkpoint só avança após a gravação bem-sucedida.

O parser aceita SOAP com o XML de negócio dentro de `PostData` em CDATA. O `iddescarga` é gerado pelo banco e `pesoliquido` é calculado como `pesoentrada - pesosaida`. Mapeamento: `idCarga` → `idcarga`; datas e horas de pesagem → `dataentrada`/`datasaida`; pesos → `pesoentrada`/`pesosaida`; `ncmProduto` → `produto`; `nomeCliente` → `cliente`; `cnpjExportador` → `cnpjexportador`; e placas → colunas correspondentes. Cargas já existentes com `cnpjexportador` vazio são relidas do XML e atualizadas sem alterar os demais campos.

O painel, o conteúdo dos dashboards e os endpoints de dados exigem autenticação. Os arquivos estáticos em `/assets` permanecem públicos e não contêm dados operacionais.

## Dashboards

Cadastre os dashboards em `dashboards.json`:

```json
[
  {
    "id": "vendas",
    "titulo": "Vendas",
    "duracaoSegundos": 45,
    "arquivo": "vendas.html"
  }
]
```

Crie o arquivo HTML correspondente em `public/dashboards/`. O conteúdo é entregue apenas a sessões autenticadas. O carrossel respeita `duracaoSegundos` por dashboard. O tempo deve ser um inteiro de pelo menos 1 segundo.
Ao detectar movimento ou clique/toque, ou interação pelo teclado, o carrossel pausa e só retoma após 5 segundos sem interação. Essa pausa também é aplicada quando a interação ocorre dentro do dashboard exibido.

O navegador consulta `/api/dashboard-data` ao abrir cada dashboard e a cada 15 minutos; os indicadores calculados no servidor são enviados à página ativa por `postMessage` com `tipo: "dados-dashboard"`. Os dados da API não são gravados no PostgreSQL. Quando a API não estiver configurada ou falhar, o painel exibe o erro e não substitui os dados por valores simulados.

O dashboard `PÁTIO DE TRIAGEM` agrupa ofertas D e D+1 por produto (contagem de cargas) e veículos em PÁTIO/VIA por placas distintas. NCMs iniciados por `1005`, `1070`, `1104` e `1201` são classificados como Milho, Sorgo, Trigo e Soja; a interface de gestão à vista destaca Soja e Milho. Cargas com `classCarAnalise=refugado` não entram nos indicadores. Oferta considera cargas sem C60; PÁTIO considera C60 sem C80; VIA considera rastro C80 ou `cargaSaiuPatio=true`. A permanência e a lista dos cinco mais antigos usam o C60 mais antigo da carga. A lista “Em Trânsito” mostra placa, produto e tempo desde a data/hora do rastro C80; quando o horário não está disponível, exibe `---`.

Quando um indicador não tiver dados, o dashboard mostra `---` no lugar de zero ou de uma mensagem de lista vazia.

O dashboard `DESCARGAS - EXPORTAÇÃO` lê o JSON anual por meio de `/api/descargas-dashboard` e filtra o mês solicitado. A consolidação usa `datasaida` para contabilizar veículos e `pesoliquido` para pesos. Turnos A, B e C são 07:00–15:20, 15:20–23:28 e 23:28–07:00 do dia seguinte. As descargas entre meia-noite e 07:00 pertencem à data operacional do turno C iniciado no dia anterior. Quando `turnodescarga.turnofolga` da data operacional coincide com o turno-base, a descarga aparece em F. O indicador superior mostra a contagem de Soja e Milho e o peso combinado do turno atual; a tabela mostra quantidades por turno, totais diários e totalizadores mensais por produto. No mês atual, a listagem posiciona automaticamente o dia corrente na área visível: do dia 1 até o 10, mostra desde o dia 1; do dia 11 ao 20, desde o dia 8; e do dia 21 em diante, desde o dia 18. O cabeçalho, total mensal e totalizadores permanecem visíveis durante a rolagem da listagem. A página atualiza os dados ao abrir e a cada 15 minutos.

## Segurança

Mantenha `PGPASSWORD`, `DASHBOARD_API_TOKEN` e a URL com a chave da fila somente no ambiente do servidor, nunca no código-fonte. Como o painel não tem autenticação, use-o somente em rede confiável e restrinja a porta do servidor a essa rede.
