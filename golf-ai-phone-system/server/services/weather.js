/**
 * Weather Service
 * Fetches current weather and forecast for Oshawa, ON
 */
require('dotenv').config();

const OSHAWA_LAT = 43.8971;
const OSHAWA_LON = -78.8658;

async function getCurrentWeather() {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    return { error: 'Weather service not configured' };
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${OSHAWA_LAT}&lon=${OSHAWA_LON}&appid=${apiKey}&units=metric`;
    const res = await fetch(url);
    const data = await res.json();

    return {
      temperature: Math.round(data.main.temp),
      feels_like: Math.round(data.main.feels_like),
      description: data.weather[0].description,
      humidity: data.main.humidity,
      wind_speed: Math.round(data.wind.speed * 3.6), // m/s to km/h
      summary: `Currently ${Math.round(data.main.temp)}°C and ${data.weather[0].description} in Oshawa. Feels like ${Math.round(data.main.feels_like)}°C. Wind ${Math.round(data.wind.speed * 3.6)} km/h.`
    };
  } catch (err) {
    console.error('Weather fetch failed:', err.message);
    return { error: 'Unable to fetch weather right now' };
  }
}

async function getForecast(days = 3) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    return { error: 'Weather service not configured' };
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${OSHAWA_LAT}&lon=${OSHAWA_LON}&appid=${apiKey}&units=metric`;
    const res = await fetch(url);
    const data = await res.json();

    // Group forecast by day and get midday readings
    const dailyForecasts = {};
    for (const item of data.list) {
      const date = item.dt_txt.split(' ')[0];
      const hour = parseInt(item.dt_txt.split(' ')[1].split(':')[0]);
      // Prefer midday readings (12:00)
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
    console.error('Forecast fetch failed:', err.message);
    return { error: 'Unable to fetch forecast right now' };
  }
}

module.exports = { getCurrentWeather, getForecast };
