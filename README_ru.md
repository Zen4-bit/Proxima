<div align="center">

<img src="assets/proxima-icon.png" alt="Proxima" width="72"/>

# Proxima

**4 ИИ-провайдера. 1 локальный сервер. Никаких API-ключей.**

Используйте ChatGPT, Claude, Gemini и Perplexity прямо в своих инструментах для разработки — через уже существующие у вас аккаунты.

<br>

[![Version](https://img.shields.io/badge/version-4.1.0-blue)](https://github.com/Zen4-bit/Proxima/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/Zen4-bit/Proxima#Install)

[![License](https://img.shields.io/badge/license-Non--Commercial-red)](LICENSE)
[![Website](https://img.shields.io/badge/Website-proximamcp.in-blue)](https://www.proximamcp.in)
[![Stars](https://img.shields.io/github/stars/Zen4-bit/Proxima?style=social)](https://github.com/Zen4-bit/Proxima/stargazers)
[![Sponsors](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/Zen4-bit)

<br>

[Начало работы](#getting-started) · [CLI](#cli-tool) · [REST API](#rest-api) · [WebSocket](#websocket) · [SDK](#sdks) · [MCP Инструменты](#mcp-tools)

<br>

**Языки:** [English](README.md) · [Roman Urdu/Hinglish](README_rour.md)

</div>

<br>

---

## Демо

**Демо приложения · CLI · Интерактивный чат и сравнение · Обзор возможностей**

<table cellspacing="0" cellpadding="0">
<tr>
<td width="50%">

https://github.com/user-attachments/assets/5e75eb68-b1b5-43dc-979d-3bf6faa48fa0

</td>
<td width="50%">

https://github.com/user-attachments/assets/a8564fc9-b3b3-4a53-bc35-cfce72fe34da

</td>
</tr>
<tr>
<td width="50%">

https://github.com/user-attachments/assets/bb7fa455-d379-4e69-b530-f7c09d2faccf

</td>
<td width="50%">

https://github.com/user-attachments/assets/d4121fdb-f97e-4d35-846c-5ec7c5249a85

</td>
</tr>
</table>

---

## Обзор

Proxima — это локальный ИИ-шлюз, который подключает несколько ИИ-провайдеров к вашей среде разработки. Он взаимодействует с каждым провайдером на уровне браузера через ваши активные сессии входа — точно так же, как вы общаетесь с ними в обычном браузере.

<br>

<table>
<tr>
<td>🌐 <strong>Один эндпоинт</strong></td>
<td>Все запросы через <code>/v1/chat/completions</code> — никаких отдельных URL</td>
</tr>
<tr>
<td>🤖 <strong>4 ИИ-провайдера</strong></td>
<td>ChatGPT, Claude, Gemini, Perplexity — любая модель, любая задача</td>
</tr>
<tr>
<td>⚡ <strong>Движки провайдеров</strong></td>
<td>Взаимодействие на уровне браузера — в 3–10 раз быстрее и надежнее</td>
</tr>
<tr>
<td>🖥️ <strong>CLI-инструмент</strong></td>
<td><code>proxima ask</code>, <code>proxima fix</code>, <code>proxima debate</code> — прямо из терминала</td>
</tr>
<tr>
<td>🔌 <strong>WebSocket</strong></td>
<td>Стриминг в реальном времени по адресу <code>ws://localhost:3210/ws</code></td>
</tr>
<tr>
<td>🧰 <strong>45+ MCP инструментов</strong></td>
<td>Поиск, код, перевод, анализ, дебаты, аудит — всё через MCP</td>
</tr>
<tr>
<td>📡 <strong>REST API</strong></td>
<td>OpenAI-совместимое API на <code>localhost:3210</code></td>
</tr>
<tr>
<td>📦 <strong>SDK</strong></td>
<td>Python и JavaScript — всего одна функция для вызова</td>
</tr>
<tr>
<td>🧠 <strong>Умный роутер</strong></td>
<td>Автоматический подбор лучшего ИИ для вашего запроса</td>
</tr>
<tr>
<td>🔑 <strong>Без API-ключей</strong></td>
<td>Использует ваши существующие браузерные сессии — см. <a href="#security--privacy">как это работает</a></td>
</tr>
<tr>
<td>🔒 <strong>Локально и приватно</strong></td>
<td>Работает на <code>127.0.0.1</code>, данные отправляются только тем провайдерам, в которых вы авторизованы</td>
</tr>
</table>

<br>

---

## Что нового в v4.1.0

<table>
<tr>
<td width="40"><strong>🔥</strong></td>
<td><strong>Система движков провайдеров</strong><br>Proxima теперь использует нативное взаимодействие с провайдерами на уровне браузера — без DOM-скрейпинга. Ответы приходят в 3–10 раз быстрее и стабильнее, поддерживается SSE-стриминг и автоматическое переключение на fallback-механизмы.</td>
</tr>
<tr>
<td><strong>⚡</strong></td>
<td><strong>CLI-инструмент</strong><br>Запускайте <code>proxima ask</code>, <code>proxima fix</code>, <code>proxima debate</code> из любого терминала. Направляйте ошибки прямо из вывода сборки. Поддерживается контекст файлов, git diff и JSON-вывод для скриптов.</td>
</tr>
<tr>
<td><strong>🔌</strong></td>
<td><strong>WebSocket-сервер</strong><br>Стриминг ИИ в реальном времени через <code>ws://localhost:3210/ws</code>. Двусторонняя связь со статусами, трекингом запросов и keepalive.</td>
</tr>
<tr>
<td><strong>🛠️</strong></td>
<td><strong>15 новых MCP инструментов</strong><br><code>chain_query</code>, <code>solve</code>, <code>debate</code>, <code>security_audit</code>, <code>verify</code>, <code>fix_error</code>, <code>build_architecture</code>, <code>write_tests</code>, <code>explain_error</code>, <code>convert_code</code>, <code>ask_selected</code>, <code>conversation_export</code>, <code>ask_perplexity</code>, <code>github_search</code>, <code>get_ui_reference</code></td>
</tr>
<tr>
<td><strong>📄</strong></td>
<td><strong>Интерактивная документация API</strong><br>Живая документация на <code>/docs</code>, <code>/cli</code>, <code>/ws</code> — с рабочим виджетом чата для тестирования запросов прямо в браузере.</td>
</tr>
<tr>
<td><strong>🎯</strong></td>
<td><strong>Мультимодельные запросы</strong><br><code>model: "all"</code> опрашивает всех провайдеров сразу. <code>model: ["claude", "chatgpt"]</code> для конкретных целей. Сравнивайте ответы нескольких ИИ в одном запросе.</td>
</tr>
<tr>
<td><strong>📤</strong></td>
<td><strong>Экспорт диалогов</strong><br>Экспортируйте полную историю общения с любым провайдером через <code>conversation_export</code>.</td>
</tr>
<tr>
<td><strong>🛡️</strong></td>
<td><strong>Новые функции REST API</strong><br>Добавлены функции <code>security_audit</code> и <code>debate</code>. Поддержка загрузки файлов через поле <code>file</code> в теле запроса.</td>
</tr>
</table>

<br>

**Исправления и улучшения:**
- 🔧 Поэтапные запросы к нескольким провайдерам — предотвращает зависания UI
- 🔧 Умный выбор провайдера — задачи по коду направляются в Claude, исследования — в Perplexity
- 🔧 Кэширование ответов с TTL (5 мин) и авто-очисткой (макс. 100 записей)
- 🔧 Обработка rate limit — детекция 429 ответов и авто-восстановление сессий
- 🔧 Авто-инъекция движка при навигации по страницам
- 🔧 Авто-восстановление диалогов Claude (обработка 404/410 ошибок)
- 🔧 Решатель SHA3-512 proof-of-work для ChatGPT
- 🔧 Лимит тела запроса REST API 10MB с CORS заголовками

---

## Начало работы

### Требования

- [Node.js 18+](https://nodejs.org/) (для MCP-сервера и CLI)
- **Windows 10/11** — доступен установщик
- **macOS / Linux** — через исходный код

<br>

### Установка

<table>
<tr>
<td width="50%">

**Установщик (Windows)**

Скачайте последнюю версию и запустите установщик.

<br>

[Скачать Proxima v4.1.0 →](https://github.com/Zen4-bit/Proxima/releases)

</td>
<td width="50%">

**Из исходного кода (Windows / macOS / Linux)**

```bash
git clone https://github.com/Zen4-bit/Proxima.git
cd Proxima
npm install
npm start
```

</td>
</tr>
</table>

> Electron откроет окно Proxima. Войдите в свои ИИ-аккаунты, включите REST API в настройках, и всё готово.

<br>

**CLI установка:**
- **Windows:** Настройки → **⚡ Установить CLI в PATH**, или <code>npm link</code>
- **macOS / Linux:** <code>npm link</code> (может потребоваться <code>sudo</code>)

<br>

### Подключение к редактору

1. Откройте Proxima и войдите в аккаунты ИИ.
2. Перейдите в **Settings → MCP Configuration** → скопируйте конфиг.
3. Вставьте его в файл настроек MCP вашего редактора:

```json
{
  "mcpServers": {
    "proxima": {
      "command": "node",
      "args": ["C:/путь/к/Proxima/src/mcp-server-v3.js"]
    }
  }
}
```

4. Перезапустите редактор. Инструменты появятся в списке.

> **Совет:** Используйте кнопку копирования в настройках — не вводите путь вручную.

**Работает с:** Cursor · VS Code (MCP extension) · Claude Desktop · Windsurf · Gemini CLI · любой MCP-совместимый клиент.

---

## Поддерживаемые провайдеры

<table>
<tr>
<td align="center" width="25%">
<br>
<strong>ChatGPT</strong>
<br>
OpenAI GPT
<br><br>
</td>
<td align="center" width="25%">
<br>
<strong>Claude</strong>
<br>
Anthropic Claude
<br><br>
</td>
<td align="center" width="25%">
<br>
<strong>Gemini</strong>
<br>
Google Gemini
<br><br>
</td>
<td align="center" width="25%">
<br>
<strong>Perplexity</strong>
<br>
Поиск и исследования
<br><br>
</td>
</tr>
</table>

Каждый провайдер работает через специальный **движок-скрипт**, обрабатывающий связь на уровне браузера. Ответы стримятся через SSE с использованием вашей текущей авторизации. Если движок не может подключиться, Proxima автоматически переходит на DOM-взаимодействие.

---

## Как это работает

В v4.1.0 Proxima использует **систему движков провайдеров** вместо DOM-скрейпинга.

```
Ваш редактор → Вызов MCP инструмента → Локальный сервер Proxima
                                            ↓
                                  Движок внедрен в сессию
                                            ↓
                             Связь на уровне браузера (SSE стрим)
                                            ↓
                                      Ответ получен
```

---

## CLI-инструмент

Используйте `proxima` CLI для работы с любым ИИ прямо из терминала.

### Команды

```bash
# Запрос к любому провайдеру
proxima ask "Как работает async/await в JS?"
proxima ask claude "Проверь этот подход"

# Поиск
proxima search "последний релиз Node.js"

# Работа с кодом
proxima code "REST API на Express с JWT"
proxima fix "SyntaxError: Unexpected token '<'"
proxima audit "SELECT * FROM users WHERE id=" + req.query.id

# Перевод
proxima translate "Hello world" --to Russian
```

### Поддержка пайпов

```bash
npm run build 2>&1 | proxima fix
git diff | proxima code review
proxima ask "Что делает этот код?" --file src/server.js
```

---

## REST API

Proxima запускает OpenAI-совместимый REST API на `http://localhost:3210`.

Включите его в **Settings → REST API & CLI**.

### Пример запроса:
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "claude", "message": "Что такое ИИ?", "function": "code"}'
```

---

## Безопасность и приватность

- **Никакие учетные данные не хранятся.** Proxima использует ваши существующие cookies.
- **Ничего не покидает вашу машину.** Только запросы к ИИ, в которых вы авторизованы.
- **Локальная работа.** Всё работает на `localhost`.
- **Никакой телеметрии.** Мы не собираем данные об использовании.

> Proxima не обходит аутентификацию — она использует сессии, которые у вас уже есть. Точно так же, как если бы вы работали в браузере.

---

## Структура проекта

```
Proxima/
├── electron/                 # Основные процессы приложения
├── cli/                      # CLI-интерфейс
├── src/                      # MCP-сервер
├── sdk/                      # SDK для Python и JS
└── ...
```

---

## Устранение неполадок

- **Windows Firewall:** Нажмите "Разрешить", Proxima работает только с локальными подключениями.
- **"Not logged in":** Для ChatGPT, Claude, Perplexity войдите через вкладку провайдера (OTP). Gemini подхватывает сессию из браузера автоматически.
- **REST API не отвечает:** Убедитесь, что оно включено в настройках.

---

**Спонсоры 💖**
-
Развитие проекта стало возможным благодаря поддержке на [GitHub](https://github.com/sponsors/Zen4-bit).

## Лицензия

Proxima предназначена **только для некоммерческого использования**. Подробности в файле [LICENSE](LICENSE).

---

<div align="center">

**Proxima v4.1.0** — Одно API, все ИИ-модели ⚡

Сделано [Zen4-bit](https://github.com/Zen4-bit) · Каждая ⭐ важна 💕

</div>
