import Promise from 'bluebird';
import MongoClient from 'mongodb';
import debugFactory from 'debug';
import { defaults, assign, identity } from 'lodash';

const debug = debugFactory('connect-mongo');

const defaultOptions = {
    collection: 'sessions',
    stringify: true,
    ttl: 60 * 60 * 24 * 14 // 14 days
};

var defaultSerializationOptions = {
    serialize: function (session) {
        // Copy each property of the session to a new object
        var obj = {};
        for (var prop in session) {
            if (prop === 'cookie') {

            // Convert the cookie instance to an object, if possible
            // This gets rid of the duplicate object under session.cookie.data property

                obj.cookie = session.cookie.toJSON ? session.cookie.toJSON() : session.cookie;
            } else {
                obj[prop] = session[prop];
            }
        }

        return obj;
    },
    unserialize: identity
};

var stringifySerializationOptions = {
    serialize: JSON.stringify,
    unserialize: JSON.parse
};

export default function connectMongo(connect) {
    const Store = connect.Store || connect.session.Store;
    const MemoryStore = connect.MemoryStore || connect.session.MemoryStore;

    class MongoStore extends Store {

        constructor(options = {}) {

            /* Fallback */

            if (options.fallbackMemory && MemoryStore) {
                return new MemoryStore();
            }

            super(options);

            /* Options */

            options = assign({}, defaultOptions, options);

            if (!options.stringify || options.serialize || options.unserialize) {
                options = defaults(options, defaultSerializationOptions);
            } else {
                options = assign(options, stringifySerializationOptions);
            }

            this.options = options;

            var self = this;

            function connectionReady(err) {
                if (err) {
                    debug('not able to connect to the database');
                    self.changeState('disconnected');
                    throw err;
                }

                self.setCollection(self.db.collection(options.collection));

                self.setAutoRemoveAsync(self.collection)
                    .then(() => self.changeState('connected'));
            }

            function initWithUrl() {
                MongoClient.connect(options.url, options.mongoOptions || {}, function(err, db) {
                    if (!err) {
                        self.db = db;
                    }
                    connectionReady(err);
                });
            }

            function initWithMongooseConnection() {
                if (options.mongooseConnection.readyState === 1) {
                    self.db = options.mongooseConnection.db;
                    process.nextTick(connectionReady);
                } else {
                    options.mongooseConnection.once('open', function() {
                        self.db = options.mongooseConnection.db;
                        connectionReady();
                    });
                }
            }

            function initWithNativeDb() {
                self.db = options.db;

                if (options.db.openCalled || options.db.openCalled === undefined) { // openCalled is undefined in mongodb@2.x
                    options.db.collection(options.collection, connectionReady);
                } else {
                    options.db.open(connectionReady);
                }
            }

            this.changeState('init');

            if (options.url) {
                debug('use strategy: `url`');
                initWithUrl();
            } else if (options.mongooseConnection) {
                debug('use strategy: `mongoose_connection`');
                initWithMongooseConnection();
            } else if (options.db && options.db.listCollections) {
                debug('use strategy: `native_db`');
                process.nextTick(initWithNativeDb);
            } else {
                throw new Error('Connection strategy not found');
            }

            this.changeState('connecting');

        }

        setAutoRemoveAsync(collection) {
            defaults(this.options, { autoRemove: 'native', autoRemoveInterval: 10 });

            switch (this.options.autoRemove) {
                case 'native':
                    return this.collection.ensureIndexAsync({ expires: 1 }, { expireAfterSeconds: 0 });
                    break;
                case 'interval':
                    let removeQuery = { expires: { $lt: new Date() } };
                    this.timer = setInterval(() => this.collection.remove(removeQuery, { w: 0 }), options.autoRemoveInterval * 1000 * 60);
                    this.timer.unref();
                    return Promise.resolve();
                    break;
                default:
                    return Promise.resolve();
                    break;
            }
        }

        changeState(newState) {
            if (newState !== this.state) {
                debug('switched to state: %s', newState);
                this.state = newState;
                this.emit(newState);
            }
        }

        setCollection(collection) {
            if (this.timer) {
                clearInterval(this.timer);
            }
            this.collectionReadyPromise = undefined;
            this.collection = collection;

            // Promisify used collection methods
            ['count', 'findOne', 'remove', 'drop', 'update', 'ensureIndex'].forEach(method => {
                collection[method + 'Async'] = Promise.promisify(collection[method], collection);
            });

            return collection;
        }

        collectionReady() {
            if (!this.collectionReadyPromise) {
                this.collectionReadyPromise = new Promise((resolve, reject) => {
                    switch (this.state) {
                        case 'connected':
                            resolve(this.collection);
                            break;
                        case 'connecting':
                            this.once('connected', () => resolve(this.collection));
                            break;
                        case 'disconnected':
                            reject(new Error('Not connected'));
                            break;
                    }
                }).bind(this);
            }
            return this.collectionReadyPromise;
        }

        computeStorageId(sessionId) {
            if (this.options.transformId && typeof this.options.transformId === 'function') {
                return this.options.transformId(sessionId);
            } else {
                return sessionId;
            }
        }

        get(sid, callback) {
            return this.collectionReady()
                .then(collection => collection.findOneAsync({
                    _id: this.computeStorageId(sid),
                    $or: [
                        { expires: { $exists: false } },
                        { expires: { $gt: new Date() } }
                    ]
                }))
                .then(session => {
                    if (session) {
                        var s = this.options.unserialize(session.session);
                        if(this.options.touchAfter > 0 && session.lastModified){
                            s.lastModified = session.lastModified;
                        }
                        this.emit('touch', sid);
                        return s;
                    }
                })
                .nodeify(callback);
        }

        set(sid, session, callback) {

            // removing the lastModified prop from the session object before update
            if(this.options.touchAfter > 0 && session && session.lastModified){
                delete session.lastModified;
            }

            var s;

            try {
                s = { _id: this.computeStorageId(sid), session: this.options.serialize(session)};
            } catch (err) {
                debug('unable to serialize session');
                return callback(err);
            }

            if (session && session.cookie && session.cookie.expires) {
                s.expires = new Date(session.cookie.expires);
            } else {
                // If there's no expiration date specified, it is
                // browser-session cookie or there is no cookie at all,
                // as per the connect docs.
                //
                // So we set the expiration to two-weeks from now
                // - as is common practice in the industry (e.g Django) -
                // or the default specified in the options.
                s.expires = new Date(Date.now() + this.options.ttl * 1000);
            }

            if(this.options.touchAfter > 0){
                s.lastModified = new Date();
            }

            return this.collectionReady()
                .then(collection => collection.updateAsync({ _id: this.computeStorageId(sid) }, s, { upsert: true }))
                .then(() => this.emit('set', sid))
                .nodeify(callback);
        }

        touch(sid, session, callback) {
            var updateFields = {},
                touchAfter = this.options.touchAfter * 1000,
                lastModified = session.lastModified ? session.lastModified.getTime() : 0,
                currentDate = new Date();

            // if the given options has a touchAfter property, check if the
            // current timestamp - lastModified timestamp is bigger than
            // the specified, if it's not, don't touch the session
            if(touchAfter > 0 && lastModified > 0){

                var timeElapsed = currentDate.getTime() - session.lastModified;

                if(timeElapsed < touchAfter){
                    return callback();
                } else {
                    updateFields.lastModified = currentDate;
                }

            }

            if (session && session.cookie && session.cookie.expires) {
                updateFields.expires = new Date(session.cookie.expires);
            } else {
                updateFields.expires = new Date(Date.now() + this.options.ttl * 1000);
            }

            return this.collectionReady()
                .then(collection => collection.updateAsync({ _id: this.computeStorageId(sid) }, { $set: updateFields }))
                .then(result => {
                    if (result.nModified === 0) {
                        throw new Error('Unable to find the session to touch');
                    } else {
                        this.emit('touch', sid);
                    }
                })
                .nodeify(callback);
        }

        destroy(sid, callback) {
            return this.collectionReady()
                .then(collection => collection.removeAsync({ _id: this.computeStorageId(sid) }))
                .then(() => this.emit('destroy', sid))
                .nodeify(callback);
        }

        length(callback) {
            return this.collectionReady()
                .then(collection => collection.countAsync({}))
                .nodeify(callback);
        }

        clear(callback) {
            return this.collectionReady()
                .then(collection => collection.dropAsync())
                .nodeify(callback);
        }

    }

    return MongoStore;
};