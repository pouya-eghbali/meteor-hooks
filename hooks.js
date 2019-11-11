import { Mongo } from 'meteor/mongo'
import genUuid from 'uuid/v4'

export const uuid = process.env.HOOKS_UUID || genUuid()
export const name = 'hooks';
export const Collections = {}

class hook {
  constructor() {
    this.findOneHooks = []
    this.insertHooks = []
    this.updateHooks = []
    this.removeHooks = []
    this.findHooks = []
  }
  findOne(fn) { this.findOneHooks.push(fn) }
  insert(fn) { this.insertHooks.push(fn) }
  update(fn) { this.updateHooks.push(fn) }
  remove(fn) { this.removeHooks.push(fn) }
  find(fn) { this.findHooks.push(fn) }
}

const setupDirects = Instance => {
  const { insert, update, remove, find, findOne } = Instance._collection
  Instance.original = { insert, update, remove, find, findOne }
  Instance.direct = {
    insert(document, ...args) {
      document.hookMeta = getHookMeta(true)
      Instance.original.insert(document, ...args)
    },
    update(selector, modifier, ...args) {
      const hookMeta = getHookMeta(false)
      modifier.$set = { ...modifier.$set, hookMeta }
      Instance.original.update(selector, modifier, ...args)
    },
    remove, find, findOne
  }
}

const ensureDirect = Instance => {
  if (!Instance.direct) {
    setupDirects(Instance)
  }
}

const silence = fn => {
  try { return fn() } catch (error) { }
}

const getUserId = () => silence(Meteor.userId)

const getHookMeta = direct => {
  return {
    timestamp: new Date(),
    userId: getUserId(),
    uuid, direct
  }
}

const setupHooks = Instance => {
  Instance.after = new hook()
  Instance.before = new hook()
  ensureDirect(Instance)
  const { _collection: collection } = Instance
  collection.update = (selector, modifier, ...args) => {
    const abort = Instance.before.updateHooks
      .map(hook => hook(selector, modifier, ...args))
      .some(result => result == false)
    if (abort) return
    const hookMeta = getHookMeta(false)
    modifier.$set = { ...modifier.$set, hookMeta }
    return Instance.original.update(selector, modifier, ...args)
  }
  collection.insert = (document, ...args) => {
    const abort = Instance.before.insertHooks
      .map(hook => hook(document, ...args))
      .some(result => result == false)
    if (abort) return
    document.hookMeta = getHookMeta(false)
    return Instance.original.insert(document, ...args)
  }
  collection.remove = (document, ...args) => {
    const abort = Instance.before.removeHooks
      .map(hook => hook(document, ...args))
      .some(result => result == false)
    if (abort) return
    document.hookMeta = getHookMeta(false)
    return Instance.original.insert(document, ...args)
  }
  collection.find = (...args) => {
    Instance.before.findHooks
      .forEach(hook => hook(...args))
    const result = Instance.original.find(...args)
    Instance.after.findHooks
      .forEach(hook => hook(result))
    return result
  }
  collection.findOne = (...args) => {
    Instance.before.findOneHooks
      .forEach(hook => hook(...args))
    const result = Instance.original.findOne(...args)
    Instance.after.findOneHooks
      .forEach(hook => hook(result))
    return result
  }
}

const setupObservers = Instance => {
  const query = { 'hookMeta.uuid': uuid, 'hookMeta.direct': false }
  Instance.observer = Instance.find(query).observe({
    added(document) {
      Instance.after.insertHooks
        .forEach(hook => hook(document))
    },
    removed(document) {
      Instance.after.removeHooks
        .forEach(hook => hook(document))
    },
    changed(current, previous) {
      Instance.after.updateHooks
        .forEach(hook => hook(current, previous))
    }
  })
}

const mutate = Parent => {
  const { Collection } = Parent
  Parent.Collection = function (name, ...args) {
    const collection = Collection.apply(this, [name, ...args])
    Collections[name] = this
    setupHooks(this)
    setupObservers(this)
    return collection
  }
  Parent.Collection.prototype = Collection.prototype
  for (let prop of Object.keys(Collection)) {
    Parent.Collection[prop] = Collection[prop]
  }
}

if (Meteor.isServer) {
  mutate(Mongo)
  mutate(Meteor)
  if (Meteor.users) {
    setupHooks(Meteor.users)
  }
}
