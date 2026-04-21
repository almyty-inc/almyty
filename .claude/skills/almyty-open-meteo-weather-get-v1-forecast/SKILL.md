---
name: almyty-open-meteo-weather-get-v1-forecast
description: 7 day weather variables in hourly and daily resolution for given WGS84 latitude and longitude coordinates. Available worldwide.
metadata:
  author: almyty
  generated: "true"
  version: "1.0.0"
---

# open_meteo_weather_get_v1_forecast

7 day weather variables in hourly and daily resolution for given WGS84 latitude and longitude coordinates. Available worldwide.

## When to use

- 7 day weather variables in hourly and daily resolution for given WGS84 latitude and longitude coordinates. Available worldwide.
- GET requests to /v1/forecast

## HTTP endpoint

```
GET https://api.open-meteo.com/v1/forecast
```

## Parameters

- `hourly` (array): Query parameter: hourly
- `daily` (array): Query parameter: daily
- `latitude` (number, **required**): WGS84 coordinate
- `longitude` (number, **required**): WGS84 coordinate
- `current_weather` (boolean): Query parameter: current_weather
- `temperature_unit` (string): Query parameter: temperature_unit
- `wind_speed_unit` (string): Query parameter: wind_speed_unit
- `timeformat` (string): If format `unixtime` is selected, all time values are returned in UNIX epoch time in seconds. Please not that all time is then in GMT+0! For daily values with unix timestamp, please apply `utc_offset_seconds` again to get the correct date.
- `timezone` (string): If `timezone` is set, all timestamps are returned as local-time and data is returned starting at 0:00 local-time. Any time zone name from the [time zone database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) is supported.
- `past_days` (integer): If `past_days` is set, yesterdays or the day before yesterdays data are also returned.

## Example

```bash
curl "https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0"
```

## Invocation

Run this tool directly:
```bash
npx @almyty/skills run @fb-1776091040/open-meteo/open-meteo-weather-get-v1-forecast --latitude <latitude> --longitude <longitude>
```
