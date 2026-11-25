import { fetchJson, endpoint } from '../request.js';

export async function readBrightness(config, { fetcher = fetch, signal } = {}) {
  const entries = [
    ['lux', config.brightness.luxEntity],
    ['backlight', config.brightness.backlightEntity],
    ['tv', config.brightness.tvEntity],
  ];
  const result = await Promise.all(entries.map(async ([key, entity]) => {
    const boundedFetch = (url, options) => fetcher(url, {
      ...options, method: 'GET',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
    });
    const state = await fetchJson(endpoint(config.haUrl, `api/states/${encodeURIComponent(entity)}`), config.haToken, boundedFetch);
    if (!state || state.entity_id !== entity || typeof state.state !== 'string' || state.state.length > 128 ||
        !state.attributes || typeof state.attributes !== 'object' || Array.isArray(state.attributes)) {
      throw new Error('brightness_state_invalid');
    }
    const attributes = key === 'lux' ? ['unit_of_measurement'] :
      key === 'backlight' ? ['min', 'max', 'step'] : ['app_id', config.brightness.artAttribute];
    return [key, {
      state: state.state,
      last_reported: state.last_reported,
      last_changed: state.last_changed,
      attributes: Object.fromEntries(attributes.map((name) => [name, state.attributes[name]])),
    }];
  }));
  return Object.fromEntries(result);
}
