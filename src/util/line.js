/* eslint-disable no-param-reassign */
import dayjs from 'dayjs';
import seedrandom from 'seedrandom';
import axios from './axios';
import bus from './bus';
import { weightedRandom } from './random';

const API_CHECK_PATH = `/rank?mode=day&date=${dayjs().format('YYYY-MM-DD')}`;
const IMAGE_CHECK_PATH = '/img-original/img/2007/09/20/19/49/36/10000_p0.jpg';
const API_PREFIX_STORE_KEY = 'pixiviz-api-prefix';

const storedApiPrefix = window.localStorage.getItem(API_PREFIX_STORE_KEY);

const A_DAY_IN_MS = 24 * 60 * 60 * 1000;

/**
 * Define image proxy host data by config
 * @param {string[]>} hosts Image proxy hosts
 */
export const defineProxyHosts = (hosts, disabled) => {
  if (typeof hosts !== 'object') {
    return;
  }
  let hostArr = Object.keys(hosts);
  if (disabled && Array.isArray(disabled) && disabled.length) {
    if (disabled.length === hostArr.length) {
      bus.$emit('proxy-not-available');
      return;
    }
    hostArr = hostArr.filter((host) => {
      if (disabled.includes(host)) {
        delete hosts[host];
        return false;
      }
      return true;
    });
    // recalculate weight
    let totalWeight = 0;
    hostArr.forEach((host) => {
      totalWeight += hosts[host];
    });
    hostArr.forEach((host) => {
      hosts[host] /= totalWeight;
    });
  }
  let hostIdxList = [];
  hostArr.forEach((host, index) => {
    Object.defineProperty(hosts, index, {
      value: host,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const weight = hosts[host] * 100;
    hostIdxList = hostIdxList.concat(new Array(Math.floor(weight)).fill(index));
  });
  // use seedrandom to ensure the sequence
  const rng = seedrandom('pixiviz');
  hostIdxList.sort(() => 0.5 - rng.quick());
  Object.defineProperty(hosts, 'idxList', {
    value: hostIdxList,
    enumerable: false,
    writable: true,
    configurable: true,
  });
};

/**
 * Define API prefix property in Pixiviz config object.
 * @param {*} conf Pixiviz config
 * @param {string[]} disabled Disabled host, optional
 */
export const defineApiPrefix = (conf, disabled) => {
  if (Array.isArray(conf.api_prefix)) {
    conf.api_prefix_list = conf.api_prefix;
    const prefixList =
      disabled && Array.isArray(disabled) && disabled.length
        ? conf.api_prefix_list.filter((prefix) => !disabled.includes(prefix))
        : conf.api_prefix_list;
    // if stored and valid, use it.
    if (storedApiPrefix && prefixList.includes(storedApiPrefix)) {
      conf.api_prefix = storedApiPrefix;
      return;
    }
    // choose one randomly
    const weight = 1.0 / prefixList.length;
    const spec = {};
    prefixList.forEach((prefix) => {
      spec[prefix] = weight;
    });
    const [prefix] = weightedRandom(spec);
    conf.api_prefix = prefix;
    window.localStorage.setItem(API_PREFIX_STORE_KEY, prefix);
  } else {
    window.localStorage.setItem(API_PREFIX_STORE_KEY, conf.api_prefix);
  }
};

const isHostAlive = (url, resolveRes) => {
  return new Promise((resolve, reject) => {
    axios
      .head(url, {
        timeout: 5000,
      })
      .then((res) => {
        if (res.status === 200) {
          resolve(resolveRes);
        } else {
          reject(new Error(`API alive check failed, status ${res.status}`));
        }
      })
      .catch((e) => {
        reject(e);
      });
  });
};

export const isAPIAlive = (prefix) => {
  return isHostAlive(`${prefix}${API_CHECK_PATH}`, prefix);
};

export const isProxyAlive = (host) => {
  return isHostAlive(`https://${host}${IMAGE_CHECK_PATH}`, host);
};

export const checkAPIHostAlive = async (conf, skip) => {
  // check user network status
  if (!navigator.onLine) {
    // user is not online
    bus.$emit('user-not-online');
    return;
  }
  const storedPrevCheckStatus = window.localStorage.getItem('pixiviz-api-failed');
  const prevCheckStatus = storedPrevCheckStatus ? JSON.parse(storedPrevCheckStatus) : false;
  if (!prevCheckStatus.pass && new Date().valueOf() - prevCheckStatus.time < A_DAY_IN_MS) {
    // previous check already failed, check all
    const checkRes = await Promise.allSettled(
      conf.api_prefix_list.map((prefix) => {
        if (skip && skip.includes(prefix)) {
          return Promise.reject(new Error('skipped'));
        }
        return isAPIAlive(prefix);
      }),
    );
    const alive = checkRes
      .map((promise) => {
        if (promise.status === 'fulfilled') {
          return promise.value;
        }
        return null;
      })
      .filter((item) => !!item);
    const disabled = [];
    conf.api_prefix_list.forEach((prefix) => {
      if (!alive.includes(prefix)) {
        disabled.push(prefix);
      }
    });
    // all API hosts are not available
    if (disabled.length === conf.api_prefix_list.length) {
      bus.$emit('api-not-available');
      return;
    }
    // output to console
    if (disabled.length) {
      // eslint-disable-next-line no-console
      console.warn('These API hosts have been disabled:', disabled);
    } else {
      window.localStorage.removeItem('pixiviz-api-disabled');
      return;
    }
    // store disabled host for 1 day
    window.localStorage.setItem(
      'pixiviz-api-disabled',
      JSON.stringify({
        hosts: disabled,
        time: new Date().valueOf(),
      }),
    );
    // define api_prefix property again
    conf.api_prefix = conf.api_prefix_list; // restore api_prefix because in the previous definition, it will be replaced with a string.
    defineApiPrefix(conf, disabled);
  } else {
    // only check current
    isAPIAlive(conf.api_prefix).catch(() => {
      // check failed, go check all
      window.localStorage.setItem(
        'pixiviz-api-failed',
        JSON.stringify({
          pass: false,
          time: new Date().valueOf(),
        }),
      );
      checkAPIHostAlive(conf, [conf.api_prefix]);
    });
  }
};

const getUnavailableProxyHosts = async (conf) => {
  let hosts = [];
  const disabled = [];
  // collect hosts
  if (typeof conf.image_proxy_host === 'object') {
    hosts = hosts.concat(Object.keys(conf.image_proxy_host));
  }
  if (typeof conf.download_proxy_host === 'object') {
    hosts = hosts.concat(Object.keys(conf.download_proxy_host));
  }
  hosts = Array.from(new Set(hosts));
  // check alive
  const checkRes = await Promise.allSettled(hosts.map((host) => isProxyAlive(host)));
  const alive = checkRes
    .map((promise) => {
      if (promise.status === 'fulfilled') {
        return promise.value;
      }
      return null;
    })
    .filter((item) => !!item);
  hosts.forEach((host) => {
    if (!alive.includes(host)) {
      disabled.push(host);
    }
  });
  return disabled;
};

export const checkProxyHostAlive = async (conf) => {
  if (!navigator.onLine) {
    // user is not online
    bus.$emit('user-not-online');
    return;
  }
  const disabled = await getUnavailableProxyHosts(conf);
  if (!disabled || !disabled.length) {
    window.localStorage.removeItem('pixiviz-proxy-disabled');
    return;
  }
  // set storage
  window.localStorage.setItem(
    'pixiviz-proxy-disabled',
    JSON.stringify({
      time: new Date().valueOf(),
      hosts: disabled,
    }),
  );
  // eslint-disable-next-line no-console
  console.warn('These proxy hosts have been disabled:', disabled);
  if (typeof conf.image_proxy_host === 'object') {
    defineProxyHosts(conf.image_proxy_host, disabled);
  }
  if (typeof conf.download_proxy_host === 'object') {
    defineProxyHosts(conf.download_proxy_host, disabled);
  }
};
