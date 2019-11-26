import { Mongo } from 'meteor/mongo'
import genUuid from 'uuid/v4'

export const uuid = process.env.HOOKS_UUID || genUuid()
export const name = 'hooks';

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

const doNothing = () => { }

const log = process.env.DEBUG == 'VERBOSE' ?
  (name, message) => console.log(new Date(), `${name}: ${message}`) :
  doNothing

const setupDirects = Instance => {
  const { insert, update, remove, find, findOne } = Instance._collection
  Instance.original = { insert, update, remove, find, findOne }
  Instance.direct = {
    insert(document, ...args) {
      document.hookMeta = getHookMeta(true)
      return Instance.original.insert(document, ...args)
    },
    update(selector, modifier, ...args) {
      const hookMeta = getHookMeta(true)
      modifier.$set = { ...modifier.$set, hookMeta }
      return Instance.original.update(selector, modifier, ...args)
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
  collection.remove = (query, ...args) => {
    const abort = Instance.before.removeHooks
      .map(hook => hook(query, ...args))
      .some(result => result == false)
    if (abort) return
    const hookMeta = { ...getHookMeta(false), removed: true }
    const $set = { hookMeta }
    return Instance.original.update(query, { $set }, { multi: true }, (err, res) => {
      if (err) throw err
      query['hookMeta.removed'] = true
      Instance.original.remove(query, ...args)
    })
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

const checkMeta = ({ hookMeta: meta }, rejectRemoved = true) => {
  return new Promise((resolve, reject) => {
    if (meta == undefined) return reject()
    if (meta.uuid != uuid) return reject()
    if (meta.direct) return reject()
    if (rejectRemoved && meta.removed) return reject()
    resolve()
  })
}

const setupObservers = Instance => {
  const { insertHooks, updateHooks, removeHooks } = Instance.after
  Instance.observer = Instance.find({}).observe({
    added(document) {
      if (Instance.observer)
        checkMeta(document)
          .then(() => log(Instance._name, 'Running added hooks'))
          .then(() => insertHooks.forEach(hook => hook(document)))
          .catch(e => log(Instance._name, e.message))
    },
    removed(document) {
      checkMeta(document)
        .then(() => log(Instance._name, 'Running removed hooks'))
        .then(() => removeHooks.forEach(hook => hook(document)))
        .catch(e => log(Instance._name, e.message))
    },
    changed(current, previous) {
      checkMeta(current, false)
        .then(() => log(Instance._name, 'Running changed hooks'))
        .then(() => updateHooks.forEach(hook => hook(current, previous)))
        .catch(e => log(Instance._name, e.message))
    }
  })
}

const mutate = Parent => {
  const { Collection } = Parent
  Parent.Collection = function (name, ...args) {
    const collection = Collection.apply(this, [name, ...args])
    if (name == null) return collection
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
