## Сборка и запуск через Docker
### Сборка образа
```bash
docker build -t directus .
```

### Запуск контейнера
```bash
docker run -p 8055:8055 directus
```

### Переменные окружения
В Dockerfile по умолчанию используются:
- `DB_CLIENT=sqlite3`
- `DB_FILENAME=/directus/database/database.sqlite`
- `NODE_ENV=production`
- `NPM_CONFIG_UPDATE_NOTIFIER=false`

*Вы можете переопределить их при запуске контейнера через флаг `-e`.*

## Запуск без Docker

1. Установите зависимости:
   ```bash
   npm i
   ```
2. Соберите проект:
   ```bash
   npm run build
   ```
3. (Опционально) Установите переменные окружения, если требуется изменить стандартные значения:
   ```bash
   export DB_CLIENT=sqlite3
   export DB_FILENAME=./database/database.sqlite
   export NODE_ENV=production
   export NPM_CONFIG_UPDATE_NOTIFIER=false
   ```
4. Запустите проект:
   ```bash
   node cli.js bootstrap
   ```
5. Для запуска с помощью pm2:
   ```bash
   pm2-runtime start ecosystem.config.cjs
   ```