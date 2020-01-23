import { Mongo } from "meteor/mongo";
import genUuid from "uuid/v4";

export const uuid = process.env.HOOKS_UUID || genUuid();
export const name = "hooks";

class hook {
  constructor() {
    this.findOneHooks = [];
    this.insertHooks = [];
    this.updateHooks = [];
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
  const { insert, update, remove, find, findOne } = Instance._collection;
  Instance.original = { insert, update, remove, find, findOne };
  Instance.direct = {
    insert(document, ...args) {
      document.hookMeta = getHookMeta(true);
      return Instance.original.insert(document, ...args);
    },
    update(selector, modifier, ...args) {
      const hookMeta = getHookMeta(true);
      modifier.$set = { ...modifier.$set, hookMeta };
      return Instance.original.update(selector, modifier, ...args);
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

const getHookMeta = direct => {
  return {
    timestamp: new Date(),
    userId: getUserId(),
    uuid,
    direct
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
    const hookMeta = getHookMeta(false);
    modifier.$set = { ...modifier.$set, hookMeta };
    return Instance.original.update(selector, modifier, ...args);
  };
  collection.insert = (document, ...args) => {
    log(Instance._name, "[insert] Collection method called");
    const abort = Instance.before.insertHooks
      .map(hook => hook(document, ...args))
      .some(result => result == false);
    if (abort) return;
    document.hookMeta = getHookMeta(false);
    return Instance.original.insert(document, ...args);
  };
  collection.remove = (query, ...args) => {
    log(Instance._name, "[remove] Collection method called");
    const abort = Instance.before.removeHooks
      .map(hook => hook(query, ...args))
      .some(result => result == false);
    if (abort) return;
    const hookMeta = { ...getHookMeta(false), removed: true };
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
  const { insertHooks, updateHooks, removeHooks } = Instance.after;
  Instance.observer = Instance.find({}).observe({
    added(document) {
      if (!Instance.observer) return undefined;
      log(Instance._name, "Checking added hook meta");
      checkMeta(document)
        .then(() => log(Instance._name, "Running added hooks"))
        .then(() => insertHooks.forEach(hook => hook(document)))
        .catch(e => log(Instance._name, e));
    },
    removed(document) {
      log(Instance._name, "Checking removed hook meta");
      checkMeta(document)
        .then(() => log(Instance._name, "Running removed hooks"))
        .then(() => removeHooks.forEach(hook => hook(document)))
        .catch(e => log(Instance._name, e));
    },
    changed(current, previous) {
      log(Instance._name, "Checking changed hook meta");
      checkMeta(current, false)
        .then(() => log(Instance._name, "Running changed hooks"))
        .then(() => updateHooks.forEach(hook => hook(current, previous)))
        .catch(e => log(Instance._name, e));
    }
  });
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
  }
}
