# TECH_STACK — стек технологий

## Язык и сборка
- TypeScript (vanilla, без React/Vue/Angular — меньше вес и быстрее загрузка)
- Vite 8 (сборка, dev-сервер, хеширование ассетов)
- ESLint + Prettier

## Рендеринг
- Three.js r187 (WebGL2)
- WebGL2 (не WebGPU — лучше совместимость со старыми телефонами и ПК)

## Физика
- @dimforge/rapier3d-compat v0.21.0 (WASM, raycast vehicle)

## Данные карты
- OpenStreetMap (ODbL лицензия)
- Overpass API / ohsome API (статистика)
- Geofabrik PBF (резервное скачивание)
- osmium-tools (обработка PBF)
- Terrarium / Mapzen heightmap (рельеф)

## Аудио
- Web Audio API (синтез двигателя, surround, фильтр салона)

## Хостинг
- GitHub Pages (через GitHub Actions)
- PWA: manifest.webmanifest + service worker

## Версии ключевых пакетов (на ноябрь 2026)
- three: 0.187.0
- vite: 8.3.8
- @dimforge/rapier3d-compat: 0.21.0

## Лицензии
- Код: MIT
- Данные карты: ODbL (атрибуция © OpenStreetMap contributors обязательна)
- Ассеты: свои или CC0 (Poly Haven, ambientCG, Kenney)

## Что НЕ используется
- Unity / Godot / Unreal (слишком тяжёлые для браузера и Pages)
- Реальные бренды автобусов (логика: вымышленный перевозчик)
- Онлайн-база данных, аккаунты, облачные сейвы (только Pages, без бэкенда)
