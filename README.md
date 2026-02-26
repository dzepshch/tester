# Тестер — Веб-приложение для подготовки к экзаменам

## Структура проекта

```
tester/
├── api/
│   └── index.py          # Flask backend (+ точка входа Vercel)
├── static/
│   ├── css/main.css
│   └── js/app.js
├── templates/
│   └── index.html
├── requirements.txt
├── vercel.json
└── README.md
```

## Локальный запуск

```bash
cd tester
pip install -r requirements.txt
python api/index.py
# Открыть http://localhost:5000
```

## Деплой на Vercel

### 1. Установите Vercel CLI
```bash
npm install -g vercel
```

### 2. Авторизуйтесь
```bash
vercel login
```

### 3. Задайте переменную окружения с ключом администратора
В Vercel Dashboard → Settings → Environment Variables:
```
ADMIN_KEY = ваш_секретный_ключ
```
Или при первом деплое CLI спросит про env-переменные.

### 4. Деплой
```bash
cd tester
vercel --prod
```

> **Важно:** SQLite на Vercel хранится во временной файловой системе `/tmp`.  
> База данных сбрасывается при каждом cold start. Для постоянного хранения  
> подключите **PlanetScale** (MySQL), **Supabase** (PostgreSQL) или **Turso** (SQLite в облаке).  
> Для учебного проекта достаточно хранить тесты в JSON-файлах или использовать Turso.

### Альтернатива с постоянной БД (Turso)

1. Зарегистрируйтесь на [turso.tech](https://turso.tech)
2. Создайте базу данных
3. Получите `TURSO_URL` и `TURSO_AUTH_TOKEN`
4. Замените `sqlite3` на `libsql-experimental` в `api/index.py`

## Переменные окружения

| Переменная | Описание | По умолчанию |
|-----------|----------|-------------|
| `ADMIN_KEY` | Ключ для входа в панель администратора | `admin123` |

**Обязательно смените ключ перед деплоем!**

## Функционал

- 📋 Список тестов с поиском
- ⏱ Таймер на тест / на вопрос
- ✅ Одиночный и множественный выбор
- 💬 Мгновенная обратная связь после ответа
- 📊 Статистика и история в профиле
- 📈 График прогресса
- ⚙️ Панель администратора с ключом доступа
- 📁 Импорт тестов из JSON и CSV
- 📱 Адаптивный дизайн

## Формат JSON для импорта

```json
{
  "title": "Название теста",
  "description": "Описание",
  "time_limit": 300,
  "questions": [
    {
      "text": "Вопрос?",
      "multiple": false,
      "answers": [
        {"text": "Верный ответ", "correct": true},
        {"text": "Неверный", "correct": false}
      ]
    }
  ]
}
```

## Формат CSV для импорта

```
test_title,test_description,question_text,answer_text,correct,multiple
История,Тест по истории,Первый император?,Пётр I,true,false
История,Тест по истории,Первый император?,Иван IV,false,false
```
