// mock-redis.js — implementa só o que db.js usa (get/set com nx/incr/expire/del),
// para testar a lógica de negócio sem precisar de uma conta Upstash real.
// Não é usado em produção; só nos testes deste projeto.

function createMockRedis(){
  var store = {};
  var expirations = {};

  function expired(key){
    return expirations[key] && Date.now() > expirations[key];
  }
  function readable(key){
    if(expired(key)){ delete store[key]; delete expirations[key]; return false; }
    return true;
  }

  return {
    _store: store, // exposto só para inspeção nos testes
    get: async function(key){
      if(!readable(key)) return null;
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    set: async function(key, value, opts){
      opts = opts || {};
      if(opts.nx && readable(key) && Object.prototype.hasOwnProperty.call(store, key)){
        return null; // já existe: NX recusa a escrita
      }
      store[key] = value;
      if(opts.ex) expirations[key] = Date.now() + opts.ex * 1000;
      else delete expirations[key];
      return "OK";
    },
    del: async function(key){
      var existed = Object.prototype.hasOwnProperty.call(store, key);
      delete store[key];
      delete expirations[key];
      return existed ? 1 : 0;
    },
    incr: async function(key){
      var cur = readable(key) && store[key] ? Number(store[key]) : 0;
      cur += 1;
      store[key] = cur;
      return cur;
    },
    expire: async function(key, seconds){
      expirations[key] = Date.now() + seconds * 1000;
      return 1;
    },
    sadd: async function(key, member){
      if(!readable(key)) delete store[key];
      var set = store[key] instanceof Set ? store[key] : new Set();
      var before = set.size;
      set.add(member);
      store[key] = set;
      delete expirations[key];
      return set.size > before ? 1 : 0;
    },
    srem: async function(key, member){
      if(!readable(key)) return 0;
      var set = store[key];
      if(!(set instanceof Set)) return 0;
      return set.delete(member) ? 1 : 0;
    },
    smembers: async function(key){
      if(!readable(key)) return [];
      var set = store[key];
      if(!(set instanceof Set)) return [];
      return Array.from(set);
    }
  };
}

module.exports = { createMockRedis };
