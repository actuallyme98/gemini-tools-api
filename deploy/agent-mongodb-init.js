// The official Mongo image runs this only when its data volume is empty.
const database = process.env.MONGO_INITDB_DATABASE;
const username = process.env.MONGODB_APP_USER;
const password = process.env.MONGODB_APP_PASSWORD;
if (
  !/^[a-z][a-z0-9_]{0,62}$/.test(database || '') ||
  ['admin', 'config', 'local'].includes(database) ||
  !/^[a-z][a-z0-9_]{0,62}$/.test(username || '') ||
  username === process.env.MONGO_INITDB_ROOT_USERNAME ||
  !password ||
  password.length < 32
) {
  throw new Error('Invalid Agent MongoDB initialization settings.');
}
db.getSiblingDB(database).createUser({
  user: username,
  pwd: password,
  roles: [{ role: 'readWrite', db: database }],
});
