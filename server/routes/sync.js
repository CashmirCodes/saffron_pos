// No longer used. The app now connects directly to a single shared
// Postgres database (see server/db.js), so every install sees the same
// live data automatically -- no push/pull sync step is needed anymore.
// Kept as an empty stub only because files in this project folder can't
// be deleted from here; safe to remove this file yourself.
module.exports = { router: require('express').Router() };
