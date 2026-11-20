# OSM city-data rebuild

Переписаны три скрипта. Фронтенд не меняется.

## Запуск

Из корня репозитория:

```bash
node --max-old-space-size=12000 tools/build-city.mjs /path/to/kazakhstan-latest.osm.pbf public/map/v1
node tools/build-meta.mjs public/map/v1 data/routes
node tools/validate-data.mjs public/map/v1 data/routes
```

Быстрый тест только центральной части Алматы:

```bash
CENTRE=1 node --max-old-space-size=12000 tools/build-city.mjs /path/to/kazakhstan-latest.osm.pbf public/map/v1-centre
node tools/validate-data.mjs public/map/v1-centre data/routes
```

`build-city.mjs` записывает:

- `public/map/v1/tiles/{x}_{z}.json`
- `public/map/v1/manifest.json`
- `public/map/v1/nav2d.json`
- `public/map/v1/stops-index.json`

## Изменения формата тайла

Существующие поля `buildings` и `roads` сохранены.

Дополнительно в каждом тайле:

- `greenZones[]`: простые закрытые OSM way-полигоны, обрезанные по границам тайла. Координаты абсолютные локальные метры `[x,z]`. Multipolygon relations с отверстиями пропускаются и считаются в manifest.
- `stops[]`: `position:[x,z]`, `yaw`, `model`, `name:{ru,kz}`, `name_ru`, `name_kz`, `lat`, `lon`, `nearestRoadId`, `distanceToRoadM`.
- `buildings[]`: `estimated`, `est` (совместимый alias), `heightSource`. `height` даёт `estimated:false`; `building:levels * 3.2` и эвристика дают `estimated:true`.

Дороги режутся по каждому пересечению сетки 2000 м. Каждый отрезок попадает в один тайл. В `manifest.roadLength` записаны исходная длина после упрощения и обрезки bbox, сумма длин тайловых фрагментов и дельта.

## Координаты

Проекция совпадает с `src/world/coords.ts`:

- origin: `lat=43.2389`, `lon=76.8897`
- X — восток
- Z — юг
- единица — метр
- тайл: `floor(x / 2000)_{floor(z / 2000)}`

`greenZones`, `roads` и `stops.position` записывают абсолютные метры относительно origin, не локальные координаты тайла.

## Обогащение маршрутных остановок

`build-meta.mjs` читает `stops-index.json` и `data/routes/{212,230,244}.json`. Он заполняет lat/lon только при единственном точном совпадении нормализованного имени. Неоднозначные и ненайденные остановки остаются с `null`, без геокодирования центра улицы.

## Что проверить в manifest.json

- `tiles.count`, `tiles.size`, `tiles.maxBytes`
- `buildings`, `roads`, `stops`, `parks`
- `stats.greenMultipolygonRelationsSkipped`
- `roadLength.sourceLengthM`
- `roadLength.tiledLengthM`
- `roadLength.deltaM <= roadLength.toleranceM`

`validate-data.mjs` дополнительно проверяет размер каждого тайла (не более 2 MiB), длины полилиний по записанным координатам, конечность координат каждой остановки и согласованность lat/lon в route JSON.
