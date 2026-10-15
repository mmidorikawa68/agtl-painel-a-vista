# Painel AGTL

Portal Node.js para gestão à vista com dashboards em carrossel e consulta à API do Porto. O servidor web apenas consulta o PostgreSQL; a importação de XML roda em um processo separado na rede local.

## Arquitetura e configuração

São dois processos independentes conectados ao mesmo banco Render:

- **Render (web):** executa `server.js`, serve as páginas, consulta a API do Porto e faz somente leituras no PostgreSQL.
- **Computador local (importador):** executa `import-descargas.js`, lê `\\srvportal` e grava as descargas. Precisa permanecer ligado para importar arquivos novos.

Requisitos: Node.js 18 ou superior. Execute `npm install` em cada ambiente.

### Render: servidor web

Configure o Web Service para executar `npm start` e cadastre as variáveis no painel do Render:

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | URL interna do PostgreSQL Render, de preferência com usuário somente leitura |
| `DASHBOARD_API_URL` | URL completa da API da fila do Porto, incluindo os parâmetros/chave necessários |
| `DASHBOARD_API_TOKEN` | Token Bearer, somente se a API exigir |

O Render fornece `PORT` automaticamente. Para desenvolvimento local do servidor, `DATABASE_URL` pode ser omitida e podem ser usadas `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` e `PGPORT`.

Para que o servidor web não possa gravar no banco, crie um usuário somente leitura como proprietário do banco e use-o em `DATABASE_URL`:

```sql
CREATE ROLE agtl_painel_leitor LOGIN PASSWORD 'use-uma-senha-forte';
GRANT CONNECT ON DATABASE agtl_painel_a_vista TO agtl_painel_leitor;
GRANT USAGE ON SCHEMA public TO agtl_painel_leitor;
GRANT SELECT ON TABLE public.descargas, public.ncm, public.turnodescarga
  TO agtl_painel_leitor;
```

### Computador local: importador

No PowerShell, configure a URL **externa** do PostgreSQL Render usando um usuário que possa gravar nas tabelas:

```powershell
$env:IMPORT_DATABASE_URL = "postgresql://USUARIO:SENHA@HOST-EXTERNO:5432/agtl_painel_a_vista"
$env:XML_BASE_PATH = "\\srvportal"
npm run import:descargas
```

O processo importa imediatamente e repete a varredura a cada 15 minutos. A máquina precisa acessar as pastas `\\srvportal\AAAA\MM\DD\SendRest` e o endpoint externo do PostgreSQL.

A tabela `painel_importacao_controle` deve existir no banco. Se ainda não foi criada, execute como proprietário do banco; em seguida crie um usuário importador com as permissões necessárias:

```sql
CREATE TABLE IF NOT EXISTS public.painel_importacao_controle (
  fonte TEXT PRIMARY KEY,
  ultima_data_processada DATE NOT NULL
);

CREATE ROLE agtl_painel_importador LOGIN PASSWORD 'use-outra-senha-forte';
GRANT CONNECT ON DATABASE agtl_painel_a_vista TO agtl_painel_importador;
GRANT USAGE ON SCHEMA public TO agtl_painel_importador;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.painel_importacao_controle TO agtl_painel_importador;
GRANT SELECT, INSERT ON TABLE public.descargas TO agtl_painel_importador;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agtl_painel_importador;
```

Na primeira execução sem marca de reconciliação, o importador varre desde 01/01/2026; depois usa o checkpoint e reexamina o último dia em cada ciclo. Considera nomes `SendRest_<idcarga>.xml`, ignora o ID `381006` e verifica o ID em `descargas` antes de inserir, sem exigir que as datas do XML coincidam com a pasta. Falhas de leitura ou XML são registradas e permitem nova tentativa no próximo ciclo. O limite é 10 MB por arquivo.

O parser aceita SOAP com o XML de negócio dentro de `PostData` em CDATA. O `iddescarga` é gerado pelo banco e `pesoliquido` é calculado como `pesoentrada - pesosaida`. Mapeamento: `idCarga` → `idcarga`; datas e horas de pesagem → `dataentrada`/`datasaida`; pesos → `pesoentrada`/`pesosaida`; `ncmProduto` → `produto`; `nomeCliente` e placas → colunas correspondentes.

Se o certificado TLS do banco não puder ser validado no computador local, `PGSSL_REJECT_UNAUTHORIZED=false` pode ser configurado como exceção consciente; a conexão continuará criptografada, mas sem validação do certificado.

O painel e seus endpoints não têm autenticação. Restrinja o acesso ao serviço conforme o uso pretendido e não o exponha à internet sem uma camada de autenticação.

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

Crie o arquivo HTML correspondente em `public/dashboards/`. O conteúdo é público, assim como o restante do painel. O carrossel respeita `duracaoSegundos` por dashboard, que deve ser um inteiro de pelo menos 1 segundo. Ao detectar movimento, clique/toque ou interação pelo teclado, o carrossel pausa e só retoma após 5 segundos sem interação, inclusive quando a interação ocorre dentro do dashboard.

O navegador consulta `/api/dashboard-data` ao abrir cada dashboard e a cada 15 minutos; os indicadores calculados no servidor são enviados à página ativa por `postMessage` com `tipo: "dados-dashboard"`. Os dados da API não são gravados no PostgreSQL. Quando a API não estiver configurada ou falhar, o painel exibe o erro e não substitui os dados por valores simulados.

O dashboard `PÁTIO DE TRIAGEM` agrupa ofertas D e D+1 por produto (contagem de cargas) e veículos em PÁTIO/VIA por placas distintas. NCMs iniciados por `1005`, `1070`, `1104` e `1201` são classificados como Milho, Sorgo, Trigo e Soja; a interface destaca Soja e Milho. Cargas com `classCarAnalise=refugado` não entram nos indicadores. Oferta considera cargas sem C60; PÁTIO considera C60 sem C80; VIA considera rastro C80 ou `cargaSaiuPatio=true`. A permanência e a lista dos cinco mais antigos usam o C60 mais antigo da carga. “Em Trânsito” mostra placa, produto e tempo desde o rastro C80; quando o horário não está disponível, exibe `---`. Indicadores sem dados mostram `---`.

O dashboard `DESCARGAS - EXPORTAÇÃO` consulta `descargas` por mês e usa `datasaida` para contabilizar veículos e `pesoliquido` para pesos. Turnos A, B e C são 07:00–15:20, 15:20–23:28 e 23:28–07:00 do dia seguinte. Descargas entre meia-noite e 07:00 pertencem à data operacional do turno C iniciado no dia anterior. Quando `turnodescarga.turnofolga` da data operacional coincide com o turno-base, a descarga aparece em F. O indicador superior mostra contagem de Soja e Milho e peso combinado do turno atual; a tabela mostra quantidades por turno, totais diários e totalizadores mensais por produto. No mês atual, a listagem posiciona automaticamente o dia corrente na área visível. O cabeçalho, total mensal e totalizadores permanecem visíveis durante a rolagem. O servidor web detecta novas descargas no banco a cada 30 segundos e notifica o dashboard; há também uma atualização de segurança a cada 15 minutos.

## Segurança

Mantenha `DATABASE_URL`, `IMPORT_DATABASE_URL`, `DASHBOARD_API_TOKEN` e a URL com a chave da fila somente nas variáveis de ambiente dos respectivos serviços, nunca no código-fonte ou em arquivos versionados. Credenciais do Render que estavam neste README foram removidas; troque a senha da conta e a senha do banco antes de voltar a utilizá-las.
