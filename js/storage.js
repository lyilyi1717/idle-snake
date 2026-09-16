// storage.js — tiny localStorage JSON helper + shared namespace.
// All game modules hang their public API off `window.NS` since this
// project has no bundler / module system (plain <script> tags, load order
// matters: storage.js -> audio.js -> economy.js -> game.js -> ui.js).
(function () {
  'use strict';

  const NS = (window.NS = window.NS || {});

  NS.storage = {
    /**
     * Read a JSON value from localStorage.
     * @param {string} key
     * @param {*} fallback returned if the key is missing or unparsable
     */
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      } catch (err) {
        console.warn('[storage] failed to read', key, err);
        return fallback;
      }
    },

    /**
     * Write a JSON value to localStorage.
     * @param {string} key
     * @param {*} value
     */
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (err) {
        console.warn('[storage] failed to write', key, err);
        return false;
      }
    },

    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (err) {
        console.warn('[storage] failed to remove', key, err);
      }
    },
  };
})();
