/**
 * Weather Service — tenant-scoped.
 *
 * Every call takes a businessId so we can look up the tenant's lat/lon (and
 * city label for the summary) from the `businesses` row. Falls back to
 * Oshawa (Valleymede's legacy coords) when a business hasn't configured
 * its coordinates yet so Phase 2 rollout doesn't regress.
 */
require('dotenv').config();
const { getBusinessById } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');

// Legacy defaults — Valleymede (Oshawa, ON). Used only when a business row
// is missing lat/lon so we never break Valleymede during the migration.
const DEFAULT_LAT = 43.8971;
const DEFAULT_LON = -78.8658;
const DEFAULT_CITY = 'Oshawa';

async function resolveLocation(businessId) {
  const business = await getBusinessById(businessId).catch(() => null);
  const lat = Number.isFinite(business?.latitude) ? business.latitude : DEFAULT_LAT;
  const lon = Number.isFinite(business?.longitude) ? business.longitude : DEFAULT_LON;
  const city = business?.city || business?.name || DEFAULT_CITY;
  return { lat, lon, city };
}

async function getCurrentWeather(businessId) {
  requireBusinessId(businessId, 'getCurrentWeather');
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    return { error: 'Weather service not configured' };
  }

  const { lat, lon, city } = await resolveLocation(businessId);

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
    const res = await fetch(url);
    const data = await res.json();

    return {
      temperature: Math.round(data.main.temp),
      feels_like: Math.round(data.main.feels_like),
      description: data.weather[0].description,
      humidity: data.main.humidity,
      wind_speed: Math.round(data.wind.speed * 3.6), // m/s → km/h
      summary: `Currently ${Math.round(data.main.temp)}°C and ${data.weather[0].description} in ${city}. Feels like ${Math.round(data.main.feels_like)}°C. Wind ${Math.round(data.wind.speed * 3.6)} km/h.`
    };
  } catch (err) {
    console.error(`[tenant:${businessId}] Weather fetch failed:`, err.message);
    return { error: 'Unable to fetch weather right now' };
  }
}

async function getForecast(businessId, days = 3) {
  requireBusinessId(businessId, 'getForecast');
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    return { error: 'Weather service not configured' };
  }

  const { lat, lon } = await resolveLocation(businessId);

  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
    const res = await fetch(url);
    const data = await res.json();

    // Group forecast by day and prefer the midday reading.
    const dailyForecasts = {};
    for (const item of data.list) {
      const date = item.dt_txt.split(' ')[0];
      const hour = parseInt(item.dt_txt.split(' ')[1].split(':')[0], 10);
      if (!dailyForecasts[date] || hour === 12) {
        dailyForecasts[date] = {
          date,
          temperature: Math.round(item.main.temp),
          description: item.weather[0].description,
          wind_speed: Math.round(item.wind.speed * 3.6)
        };
      }
    }

    const forecasts = Object.values(dailyForecasts).slice(0, days);
    const summary = forecasts.map(f => {
      const d = new Date(f.date + 'T12:00:00');
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
      return `${dayName}: ${f.temperature}°C, ${f.description}`;
    }).join('. ');

    return { forecasts, summary };
  } catch (err) {
    console.error(`[tenant:${businessId}] Forecast fetch failed:`, err.message);
    return { error: 'Unable to fetch forecast right now' };
  }
}

module.exports = { getCurrentWeather, getForecast };
