# Лицензии внешних ассетов

Все игровые ассеты хранятся локально в репозитории. Во время игры запросы к сторонним CDN не выполняются.

| Ассет | Автор / источник | Лицензия | Дата загрузки | Файл в проекте |
|---|---|---|---|---|
| Non-step City Bus (LOD0/1/2) | Tevy — https://tevy.dev/models/non-step-city-bus (прямые файлы `/models/non-step-city-bus/v1/lod{0,1,2}.glb`) | CC0 1.0 (указано в `asset.copyright` GLB: «CC0 1.0, https://tevy.dev») | 2026-11-22 | `public/models/vehicles/tevy-non-step-city-bus*.glb` |
| Basis Universal transcoder (KTX2) | three.js / Binomial LLC — `node_modules/three/examples/jsm/libs/basis/` | Apache-2.0 (часть three.js / Basis Universal) | 2026-11-22 | `public/basis/basis_transcoder.js`, `public/basis/basis_transcoder.wasm` |
| Meshopt decoder | three.js / meshoptimizer (Зиновьев) — `node_modules/three/examples/jsm/libs/meshopt_decoder.module.js` | MIT | 2026-11-22 | импортируется из `three/addons/libs/` |

## Модель автобуса

- Исходный GLB: Tevy Non-step City Bus, 36 395 треугольников (LOD0), 13 102 (LOD1), 4 534 (LOD2).
- Материалы PBR, 32/29/22 материала, UV-развёртка есть у 5/20 мешей (основные поверхности), карты `body_ao` и `tire_normal` в KTX2/Basis.
- В проекте модель отражена и повёрнута для левостороннего водителя и правых пассажирских дверей (Алматы, правостороннее движение).
- Старый процедурный GLB (`public/models/variants/*.glb`) сохранён как fallback и для трёх ливрей.

## Карта

Геометрия зданий/дорог/остановок построена из OpenStreetMap (© OpenStreetMap contributors, ODbL) скриптом `tools/build-city.mjs`.
