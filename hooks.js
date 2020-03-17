import { Mongo } from "meteor/mongo";
import { Random } from "meteor/random";
import genUuid from "uuid/v4";

export const uuid = process.env.HOOKS_UUID || genUuid();
export const interval = process.env.HOOKS_INTERVAL
  ? Number(process.env.HOOKS_INTERVAL)
  : 1000 * 60 * 1; // every 1 minute
export const name = "hooks";

class hook {
  constructor() {
    this.findOneHooks = [];
    this.insertHooks = [];
    this.updateHooks = [];
    this.upsertHooks = [];
    this.removeHooks = [];
    this.findHooks = [];
  }
  findOne(fn) {
    this.findOneHooks.push(fn);
  }
  insert(fn) {
    this.insertHooks.push(fn);
  }
  update(fn) {
    this.updateHooks.push(fn);
  }
  upsert(fn) {
    this.upsertHooks.push(fn);
  }
  remove(fn) {
    this.removeHooks.push(fn);
  }
  find(fn) {
    this.findHooks.push(fn);
  }
}

const doNothing = () => {};

const log =
  process.env.DEBUG == "VERBOSE"
    ? (name, message) => console.log(new Date(), `${name}: ${message}`)
    : doNothing;

const setupDirects = Instance => {
  const {
    insert,
    update,
    upsert,
    remove,
    find,
    findOne
  } = Instance._collection;
  Instance.original = { insert, update, upsert, remove, find, findOne };
  Instance.direct = {
    insert(document, ...args) {
      document.hookMeta = getHookMeta("insert", true);
      return Instance.original.insert(document, ...args);
    },
    update(selector, modifier, ...args) {
      const hookMeta = getHookMeta("update", true);
      modifier.$set = { ...modifier.$set, hookMeta };
      return Instance.original.update(selector, modifier, ...args);
    },
    upsert(selector, modifier, ...args) {
      const hookMeta = getHookMeta("upsert", true);
      modifier.$set = { ...modifier.$set, hookMeta };
      modifier.$setOnInsert = { _id: Random.id() };
      return Instance.original.upsert(selector, modifier, ...args);
    },
    remove,
    find,
    findOne
  };
};

const ensureDirect = Instance => {
  if (!Instance.direct) {
    setupDirects(Instance);
  }
};

const silence = fn => {
  try {
    return fn();
  } catch (error) {}
};

const getUserId = () => silence(Meteor.userId);

const getHookMeta = (method, direct) => {
  return {
    timestamp: new Date(),
    userId: getUserId(),
    uuid,
    direct,
    method
  };
};

const setupHooks = Instance => {
  Instance.after = new hook();
  Instance.before = new hook();
  ensureDirect(Instance);
  const { _collection: collection } = Instance;
  collection.update = (selector, modifier, ...args) => {
    log(Instance._name, "[update] Collection method called");
    const abort = Instance.before.updateHooks
      .map(hook => hook(selector, modifier, ...args))
      .some(result => result == false);
    if (abort) return;
    const hookMeta = getHookMeta("update", false);
    modifier.$set = { ...modifier.$set, hookMeta };
    return Instance.original.update(selector, modifier, ...args);
  };
  collection.upsert = (selector, modifier, ...args) => {
    log(Instance._name, "[upsert] Collection method called");
    const abort = Instance.before.upsertHooks
      .map(hook => hook(selector, modifier, ...args))
      .some(result => result == false);
    if (abort) return;
    const hookMeta = getHookMeta("upsert", false);
    modifier.$set = { ...modifier.$set, hookMeta };
    modifier.$setOnInsert = { _id: Random.id() };
    return Instance.original.upsert(selector, modifier, ...args);
  };
  collection.insert = (document, ...args) => {
    log(Instance._name, "[insert] Collection method called");
    const abort = Instance.before.insertHooks
      .map(hook => hook(document, ...args))
      .some(result => result == false);
    if (abort) return;
    document.hookMeta = getHookMeta("insert", false);
    return Instance.original.insert(document, ...args);
  };
  collection.remove = (query, ...args) => {
    log(Instance._name, "[remove] Collection method called");
    const abort = Instance.before.removeHooks
      .map(hook => hook(query, ...args))
      .some(result => result == false);
    if (abort) return;
    const hookMeta = { ...getHookMeta("remove", false), removed: true };
    const $set = { hookMeta };
    return new Promise((resolve, reject) => {
      Instance.original.update(query, { $set }, { multi: true }, (err, res) => {
        if (err) reject(error);
        query["hookMeta.removed"] = true;
        const result = Instance.original.remove(query, ...args);
        resolve(result);
      });
    });
  };
  collection.find = (...args) => {
    log(Instance._name, "[find] Collection method called");
    Instance.before.findHooks.forEach(hook => hook(...args));
    const result = Instance.original.find(...args);
    Instance.after.findHooks.forEach(hook => hook(result));
    return result;
  };
  collection.findOne = (...args) => {
    log(Instance._name, "[findOne] Collection method called");
    Instance.before.findOneHooks.forEach(hook => hook(...args));
    const result = Instance.original.findOne(...args);
    Instance.after.findOneHooks.forEach(hook => hook(result));
    return result;
  };
};

const checkMeta = ({ hookMeta: meta }, rejectRemoved = true) => {
  return new Promise((resolve, reject) => {
    if (meta == undefined) return reject("No meta");
    if (meta.uuid != uuid) return reject("UUID does not match");
    if (meta.direct) return reject("Is direct");
    if (rejectRemoved && meta.removed) return reject("Is removed");
    resolve();
  });
};

const setupObservers = Instance => {
  if (Meteor.isServer) {
    const {
      insertHooks,
      updateHooks,
      upsertHooks,
      removeHooks
    } = Instance.after;
    Instance.lastHookRun = new Date();
    Instance.interval =
      Instance.interval ||
      Meteor.setInterval(function() {
        log(Instance._name, "Running hooks");
        const { lastHookRun } = Instance;
        Instance.lastHookRun = new Date();
        const query = method => ({
          "hookMeta.uuid": uuid,
          "hookMeta.method": method,
          "hookMeta.timestamp": { $gt: lastHookRun }
        });
        Instance.find(query("insert")).forEach(document => {
          log(Instance._name, "Checking added hook meta");
          checkMeta(document)
            .then(() => log(Instance._name, "Running insert hooks"))
            .then(() => insertHooks.forEach(hook => hook(document)))
            .catch(e => log(Instance._name, e));
        });
        Instance.find(query("update")).forEach(document => {
          checkMeta(document)
            .then(() => log(Instance._name, "Running update hooks"))
            .then(() => updateHooks.forEach(hook => hook(document)))
            .catch(e => log(Instance._name, e));
        });
        Instance.find(query("upsert")).forEach(document => {
          checkMeta(document)
            .then(() => log(Instance._name, "Running upsert hooks"))
            .then(() => upsertHooks.forEach(hook => hook(document)))
            .catch(e => log(Instance._name, e));
        });
        // this won't work, I need to fix this
        Instance.find(query("remove")).forEach(document => {
          checkMeta(document)
            .then(() => log(Instance._name, "Running remove hooks"))
            .then(() => removeHooks.forEach(hook => hook(document)))
            .catch(e => log(Instance._name, e));
        });
      }, interval);
  }
};

const mutate = Parent => {
  const { Collection } = Parent;
  Parent.Collection = function(name, ...args) {
    const collection = Collection.apply(this, [name, ...args]);
    if (name == null) return collection;
    setupHooks(this);
    setupObservers(this);
    return collection;
  };
  Parent.Collection.prototype = Collection.prototype;
  for (let prop of Object.keys(Collection)) {
    Parent.Collection[prop] = Collection[prop];
  }
};

if (Meteor.isServer) {
  mutate(Mongo);
  mutate(Meteor);
  if (Meteor.users) {
    setupHooks(Meteor.users);
    setupObservers(Meteor.users);
  }
}
