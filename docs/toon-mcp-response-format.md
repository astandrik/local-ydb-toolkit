# TOON формат для MCP ответов local-ydb

Документ фиксирует, где именно в MCP сервере применяется TOON, какие части MCP протокола остаются JSON, и как проводилось сравнение JSON/TOON на статических фикстурах и на реальных `local-ydb` стэках.

## Коротко

`LOCAL_YDB_MCP_CONTENT_FORMAT=toon` меняет только LLM-facing текстовый блок успешного результата tool call:

```ts
content[1].text
```

Не меняются:

- MCP транспорт и JSON-RPC сообщения stdio сервера.
- Tool input schemas.
- `structuredContent`.
- Первый текстовый блок `content[0].text`, где лежит короткий summary.
- Error responses, которые остаются обычным текстом и `{ error }` в `structuredContent`.
- MCP prompts: они возвращают workflow-инструкции и не форматируются через TOON.

По умолчанию используется `json`. TOON включается только явно:

```json
{
  "env": {
    "LOCAL_YDB_MCP_CONTENT_FORMAT": "toon"
  }
}
```

## Где это реализовано

Основная логика находится в `packages/mcp-server/src/response-format.ts`.

Точка форматирования успешного tool response:

- `packages/mcp-server/src/responses.ts`
- `successResult(result, options)` возвращает:
  - `content[0].text`: `summary` или fallback-текст.
  - `content[1].text`: результат `formatResponseContent(result, options)`.
  - `structuredContent`: исходный `result`.

Выбор формата:

- `resolveResponseContentFormat()` читает `LOCAL_YDB_MCP_CONTENT_FORMAT`.
- Валидные значения: `json`, `toon`.
- Пустое значение означает `json`.
- Невалидное значение кидает ошибку с текстом `Invalid LOCAL_YDB_MCP_CONTENT_FORMAT: expected "json" or "toon"`.

Важно: в `packages/mcp-server/src/server.ts` формат валидируется до вызова tool handler:

```ts
const responseContentFormat = resolveResponseContentFormat(options.responseContentFormat);
const callOptions = { ...options, responseContentFormat };
return successResult(
  await handler(request.params.arguments ?? {}, callOptions),
  callOptions,
);
```

Это защищает mutating tools: если формат сконфигурирован неверно, `confirm: true` операция не стартует и сервер возвращает tool error до выполнения команд.

## Как именно кодируется результат

`formatResponseContent()` сначала приводит результат к JSON data model:

```ts
const serialized = JSON.stringify(result);
const jsonModel = serialized === undefined ? null : JSON.parse(serialized);
```

Зачем это нужно:

- MCP транспорт все равно сериализует данные как JSON.
- `undefined` в объектах исчезает, как в JSON.
- Значения, не представимые в JSON data model, не становятся частью текстового payload.
- TOON round-trip сравнивается именно с тем, что реально выразимо как JSON.

В режиме `json` возвращается текущий pretty JSON:

```ts
JSON.stringify(jsonModel, null, 2)
```

В режиме `toon`:

```ts
const toon = encode(jsonModel);
return decodesToJsonModel(toon, jsonModel)
  ? toon
  : JSON.stringify(jsonModel, null, 2);
```

То есть сервер:

1. Кодирует JSON data model через `encode()` из `@toon-format/toon`.
2. Сразу декодирует текст через `decode()`.
3. Сравнивает декодированный объект с исходной JSON моделью через стабильный JSON с отсортированными ключами.
4. Если decode падает или объект отличается, возвращает pretty JSON вместо TOON.

Этот fallback нужен для payload-ов, где текущая TOON библиотека не дает lossless round-trip. На реальном прогоне такими payload-ами оказались ответы `local_ydb_container_logs`.

## Где настройка видна пользователю

Runtime dependency:

- `packages/mcp-server/package.json`
- `@toon-format/toon@^2.3.0`

MCP registry metadata:

- `server.json`
- `environmentVariables[]` содержит `LOCAL_YDB_MCP_CONTENT_FORMAT`.
- Переменная optional, placeholder `toon`.

MCP client examples:

- `README.md`
- `packages/mcp-server/README.md`

Для `npx`, global install и local checkout переменная указывается рядом с `LOCAL_YDB_TOOLKIT_CONFIG`.

## Unit/integration проверки в коде

Основные проверки находятся в `packages/mcp-server/test/tools.test.ts`:

- default формат равен `json`.
- forced `json` совпадает с текущим `JSON.stringify(result, null, 2)`.
- forced `toon` отличается от pretty JSON и декодируется обратно в тот же объект.
- TOON форматируется против JSON data model, поэтому optional `undefined` поля ведут себя как при JSON сериализации.
- При non-lossless TOON сервер возвращает JSON fallback.
- Невалидный формат возвращает tool error.
- Невалидный формат отклоняется до confirmed mutation, executor не получает команд.

Docs consistency проверка находится в `packages/mcp-server/test/docs-consistency.test.ts`:

- `server.json` должен объявлять `LOCAL_YDB_TOOLKIT_CONFIG`.
- `server.json` должен объявлять `LOCAL_YDB_MCP_CONTENT_FORMAT`.

## Статическое сравнение форматов

Команда:

```bash
npm run compare:formats -w @astandrik/local-ydb-mcp
```

Скрипт:

- `packages/mcp-server/scripts/compare-formats.mjs`

Что делает скрипт:

1. Берет репрезентативные MCP result fixtures.
2. Для каждого result приводит данные к той же JSON data model, что и server runtime: `JSON.parse(JSON.stringify(result))`.
3. По этой JSON модели строит:
   - pretty JSON: `JSON.stringify(jsonModel, null, 2)`.
   - TOON: `encode(jsonModel)`.
4. Считает bytes через `Buffer.byteLength(text, "utf8")`.
5. Считает tokens через `gpt-tokenizer@^3.4.0` и `countTokens()`.
6. Проверяет round-trip: `decode(toonText)` должен совпасть с `jsonModel`.

Фикстуры:

- `inventory`
- `status_report`
- `bootstrap_plan`
- `scheme`
- `permissions_plan`
- `list_versions`
- `nodes_check`

Последний локальный запуск:

```text
fixture           jsonB  toonB  byteDelta  jsonTok  toonTok  tokenDelta  roundTrip
----------------  -----  -----  ---------  -------  -------  ----------  ---------
inventory         1475   933    -36.7%     492      333      -32.3%      yes
status_report     1965   1316   -33.0%     580      403      -30.5%      yes
bootstrap_plan    929    808    -13.0%     256      213      -16.8%      yes
scheme            367    296    -19.3%     117      87       -25.6%      yes
permissions_plan  711    605    -14.9%     182      140      -23.1%      yes
list_versions     353    270    -23.5%     131      100      -23.7%      yes
nodes_check       502    207    -58.8%     154      68       -55.8%      yes
TOTAL             6302   4435   -29.6%     1912     1344     -29.7%      yes
```

Вывод по статическим фикстурам: TOON заметно компактнее на типичных структурированных ответах, особенно на uniform arrays вроде node lists.

## Реальное end-to-end сравнение через stdio MCP

Цель полного прогона была проверить не только размер текста, но и то, что агент получает семантически одинаковые ответы при реальных tool calls.

Использовался уже собранный реальный MCP сервер:

```bash
npm run build
node packages/mcp-server/dist/index.js
```

Сервер запускался через MCP SDK `StdioClientTransport` два раза:

1. `LOCAL_YDB_MCP_CONTENT_FORMAT=json`
2. `LOCAL_YDB_MCP_CONTENT_FORMAT=toon`

Оба запуска использовали один временный config file:

```text
/var/folders/zs/cv0s4tk50nl83pw7y1tw85g80000gn/T/local-ydb-mcp-format-e2e-fixed-hRdftE/local-ydb.config.json
```

Для JSON и TOON создавались отдельные disposable профили, контейнеры, volumes, networks и порты, чтобы результаты не пересекались:

- JSON root profile: `e2e3-json-root`
- JSON tenant/auth profiles: `e2e3-json-clean`, `e2e3-json-auth`
- TOON root profile: `e2e3-toon-root`
- TOON tenant/auth profiles: `e2e3-toon-clean`, `e2e3-toon-auth`

Mutating tools запускались с `confirm: true`. В конце прогон выполнял teardown и cleanup. После прогона отдельно проверялось, что временных `e2e3-*` Docker containers, volumes и networks не осталось.

### Что сравнивалось на каждом tool call

Для каждого сценария сохранялись:

- tool label.
- tool name.
- JSON status.
- TOON status.
- `content[1].text` bytes.
- `content[1].text` tokens.
- `jsonRoundTrip`.
- `toonRoundTrip`.
- `jsonTextFormat`: всегда `json`.
- `toonTextFormat`: `toon` или `json-fallback`.
- `normalizedStableEqual`.
- summary.

Парсинг:

- JSON run: `content[1].text` парсился как JSON.
- TOON run: сначала пробовался `decode()` из `@toon-format/toon`; если decode не проходил, текст парсился как JSON fallback.

Семантическое сравнение делалось по нормализованной стабильной модели, потому что JSON и TOON прогоны используют разные profile names, tenant names, container names, ports и временные paths. Например `/local/jsontenant3` и `/local/toontenant3` должны считаться одинаковым сценарием, если статус, структура результата и смысл совпали.

### Какие сценарии покрывались

Всего было покрыто 84 tool comparisons.

Группы сценариев:

- Inventory/status:
  - `local_ydb_inventory`
  - `local_ydb_status_report`
  - `local_ydb_storage_leftovers`
- Prerequisites:
  - `local_ydb_check_prerequisites` plan и confirm
- Registry/image:
  - `local_ydb_list_versions`
  - `local_ydb_pull_image` plan и confirm
  - `local_ydb_pull_status`
- Root bootstrap:
  - `local_ydb_bootstrap_root_database` plan и confirm
  - `local_ydb_scheme` после root bootstrap
- Tenant lifecycle:
  - `local_ydb_bootstrap` plan и confirm
  - `local_ydb_create_tenant`
  - `local_ydb_database_status`
  - `local_ydb_start_dynamic_node`
  - `local_ydb_tenant_check`
  - `local_ydb_restart_stack`
  - `local_ydb_destroy_stack`
- Read-only checks:
  - `local_ydb_container_logs`
  - `local_ydb_nodes_check`
  - `local_ydb_graphshard_check`
  - `local_ydb_storage_placement`
  - `local_ydb_auth_check`
  - `local_ydb_scheme`
  - `local_ydb_permissions`
- Backup/restore:
  - `local_ydb_dump_tenant`
  - `local_ydb_restore_tenant`
- Auth hardening:
  - `local_ydb_prepare_auth_config`
  - `local_ydb_write_dynamic_auth_config`
  - `local_ydb_apply_auth_hardening`
  - `local_ydb_set_root_password`
- Permissions mutations:
  - grant
  - revoke
  - set
  - clear
  - chown
  - set inheritance
  - clear inheritance
- Dynamic nodes:
  - `local_ydb_add_dynamic_nodes`
  - `local_ydb_remove_dynamic_nodes`
- Storage:
  - `local_ydb_add_storage_groups`
  - `local_ydb_reduce_storage_groups`
  - `local_ydb_cleanup_storage`
- Upgrade:
  - `local_ydb_upgrade_version`

Prompts тоже сверялись отдельно. Было 6 prompt comparisons:

- `local_ydb_diagnose_stack`
- `local_ydb_bootstrap_root_workflow`
- `local_ydb_bootstrap_tenant_workflow`
- `local_ydb_upgrade_version_workflow`
- `local_ydb_auth_hardening_workflow`
- `local_ydb_reduce_storage_groups_workflow`

TOON на prompts не применяется, поэтому prompt comparison проверял, что включение env var не меняет workflow-инструкции. Во всех 6 случаях normalized text был одинаковым; в метрике harness фиксировалась разница 1 token на prompt.

### Итоговые отчеты e2e

Основной отчет последнего полного прогона:

```text
/var/folders/zs/cv0s4tk50nl83pw7y1tw85g80000gn/T/local-ydb-mcp-format-e2e-fixed-hRdftE/report.json
```

В основном отчете было 83 comparisons. Один легкий plan-only сценарий `01C pull image plan` был добран отдельно, чтобы набор labels совпал с предыдущим полным отчетом на 84 comparisons:

```text
/var/folders/zs/cv0s4tk50nl83pw7y1tw85g80000gn/T/local-ydb-mcp-format-e2e-fixed-hRdftE/pull-image-plan-supplement.json
```

Итоговый объединенный отчет:

```text
/var/folders/zs/cv0s4tk50nl83pw7y1tw85g80000gn/T/local-ydb-mcp-format-e2e-fixed-hRdftE/report-plus-supplement.json
```

Итог по 84 comparisons:

```text
jsonTokens:         193165
toonTokens:         180464
tokenDelta:         -12701
tokenDeltaPct:      -6.575207723966557

jsonBytes:          567948
toonBytes:          513935
byteDelta:          -54013
byteDeltaPct:       -9.510201638178144

mismatches:         0
roundTripFailures:  0
toonFallbacks:      3
```

TOON fallbacks были только на логовых payload-ах:

- `05 static logs`
- `05 dynamic logs`
- `11 dynamic logs after add`

Это означает: сервер был запущен в `toon` режиме, но для конкретного `content[1].text` вернул pretty JSON, потому что TOON не прошел lossless decode check. `structuredContent` при этом остался обычным JSON result, а round-trip issue в итоговом отчете отсутствует.

### Ранее проблемные кейсы

В предыдущем полном прогоне были содержательные расхождения:

- `02 root bootstrap confirm`: JSON `OK`, TOON `PARTIAL 5/6`.
- `02 root scheme`: JSON `OK`, TOON `NOT_OK`.

После исправления ожидания root database metadata оба кейса прошли одинаково:

- `02 root bootstrap confirm`: JSON `OK`, TOON `OK`.
- `02 root scheme`: JSON `OK`, TOON `OK`.

Оставшиеся non-OK statuses были симметричны между JSON и TOON:

- `00 prerequisites plan`: `PARTIAL 3/4`.
- `00 prerequisites confirm`: `PARTIAL 3/4`.
- `01 scheme before`: `NOT_OK`.
- `01 permissions before`: `NOT_OK`.
- `07 dump tenant confirm`: `PARTIAL 1/2`.

Для всех этих строк `normalizedStableEqual: true`; это не форматные mismatch-и.

## Как воспроизвести базовые проверки

Минимальный локальный набор:

```bash
npm test -- packages/mcp-server/test/tools.test.ts
npm test -- packages/mcp-server/test/docs-consistency.test.ts
npm run typecheck -w @astandrik/local-ydb-mcp
npm run build -w @astandrik/local-ydb-mcp
npm run compare:formats -w @astandrik/local-ydb-mcp
```

Stdio smoke вручную:

```bash
LOCAL_YDB_TOOLKIT_CONFIG=/path/to/local-ydb.config.json \
LOCAL_YDB_MCP_CONTENT_FORMAT=toon \
node packages/mcp-server/dist/index.js
```

Через MCP client вызвать read-only tool, например `local_ydb_inventory`, и проверить:

- JSON-RPC ответ успешный.
- `structuredContent` является JSON object.
- `content[1].text` в большинстве структурированных ответов является TOON.
- Для non-lossless payload возможен JSON fallback.

## Практический вывод

Текущая реализация безопасна для production opt-in:

- default остается `json`.
- TOON включается только через env var.
- Невалидный env var блокирует handler до выполнения confirmed mutations.
- `structuredContent` сохраняет машинно-читаемый JSON result.
- Non-lossless TOON payload автоматически возвращается как pretty JSON.

По измерениям:

- На статических типичных фикстурах экономия около `29.7%` tokens.
- На полном реальном lifecycle/auth/storage/upgrade прогоне экономия около `6.6%` tokens и `9.5%` bytes.
- Содержательных JSON/TOON mismatch-ей на исправленном коде нет.
