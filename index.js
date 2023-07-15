const express = require('express')
const nunjucks = require('nunjucks')
var dateFilter = require('nunjucks-date-filter')
var markdown = require('nunjucks-markdown')
var marked = require('marked')
const bodyParser = require('body-parser')
const path = require('path')
const config = require('./app/config')
const forceHttps = require('express-force-https');
const compression = require('compression');
const favicon = require('serve-favicon');
const crypto = require('crypto');
const Airtable = require('airtable');
require('dotenv').config()

const app = express()
const base = new Airtable({ apiKey: process.env.basetoken }).base(process.env.baseid);

var NotifyClient = require('notifications-node-client').NotifyClient
const notify = new NotifyClient(process.env.notifyKey)

app.use(compression());

const session = require('express-session');

app.use(session({
  secret: '0f334f786f7f2of7f2d9h347f2972497fg37f7',
  resave: false,
  saveUninitialized: false
}));

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(favicon(path.join(__dirname, 'public/assets/images', 'favicon.ico')));

app.set('view engine', 'html')

app.locals.serviceName = config.serviceName

// Set up Nunjucks as the template engine
var nunjuckEnv = nunjucks.configure(
  [
    'app/views',
    'node_modules/govuk-frontend',
    'node_modules/dfe-frontend-alpha/packages/components',
  ],
  {
    autoescape: true,
    express: app,
  },
)

nunjuckEnv.addFilter('date', dateFilter)
markdown.register(nunjuckEnv, marked.parse)

nunjuckEnv.addFilter('formatNumber', function (number) {
  return number.toLocaleString();
});

app.use(forceHttps);

// Set up static file serving for the app's assets
app.use('/assets', express.static('public/assets'))

app.use((req, res, next) => {
  if (req.url.endsWith('/') && req.url.length > 1) {
    const canonicalUrl = req.url.slice(0, -1);
    res.set('Link', `<${canonicalUrl}>; rel="canonical"`);
  }
  next();
});

app.post('/submit', express.urlencoded({ extended: false }), async (req, res) => {
  const email = req.body.email;

  // Check if the email exists in Airtable
  const records = await base('Users').select({
    filterByFormula: `{Email} = '${email}'`
  }).firstPage();

  if (records.length === 0) {
    // Email doesn't exist, create a new entry and generate a token
    const token = generateToken(32);
    const expiryDate = getExpiryDate();

    // Expire previous tokens for the email address
    await expirePreviousTokens(email);

    await base('Users').create({ Name: '', Email: email });


    // Create a new entry in the Tokens table
    await base('Tokens').create({ Email: email, Token: token, ExpiryDate: expiryDate });


    // Send the magic link email
    await sendMagicLinkEmail(token);

    res.redirect('/check-email/index')
  } else {
    // Email exists, generate a new token and send the magic link email
    const token = generateToken(32);

    // Expire previous tokens for the email address
    await expirePreviousTokens(email);

    // Create a new entry in the Tokens table
    const expiryDate = getExpiryDate();
    await base('Tokens').create({ Email: email, Token: token, ExpiryDate: expiryDate });

    // Send the magic link email
    await sendMagicLinkEmail(token);

    res.redirect('/check-email/index')
  }
});

app.get('/signin/:id', async (req, res) => {
  const token = req.params.id;

  // Check if the token is valid and hasn't expired
  const records = await base('Tokens').select({
    filterByFormula: `{Token} = '${token}'`,
    maxRecords: 1
  }).firstPage();

  console.log(records)

  if (records.length === 0 || new Date(records[0].get('ExpiryDate')) < new Date()) {
    // Token is invalid or expired
    res.send('Sorry, you can\'t sign in.');
  } else {
    req.session.email = records[0].get('Email');
    req.session.token = records[0].get('Token');
    // Token is valid, set the session cookie and redirect to the dashboard
    res.cookie('session', token, { maxAge: 3 * 60 * 60 * 1000, httpOnly: true });
    res.redirect('/dashboard');

    // Delete the token
    await expirePreviousTokens(records[0].get('Email'))
  }
});

app.get('/dashboard', authenticate, (req, res) => {
  res.render('auth-views/dashboard/index');
});

// Sign out route
app.get('/sign-out', (req, res) => {
  req.session.destroy(); // Destroy the session
  res.clearCookie('session'); // Clear the session cookie

  res.redirect('/signed-out'); // Redirect to sign-out confirmation page
});

function authenticate(req, res, next) {
  if (req.session && req.session.email) {
    // User is authenticated, proceed to the next middleware or route handler
    next();
  } else {
    // User is not authenticated, redirect to the sign-in page or display an error
    res.redirect('/sign-in');
  }
}
app.get(/\.html?$/i, function (req, res) {
  var path = req.path
  var parts = path.split('.')
  parts.pop()
  path = parts.join('.')
  res.redirect(path)
})

app.get(/^([^.]+)$/, function (req, res, next) {
  matchRoutes(req, res, next)
})

// Handle 404 errors
app.use(function (req, res, next) {
  res.status(404).render('error.html')
})

// Handle 500 errors
app.use(function (err, req, res, next) {
  console.error(err.stack)
  res.status(500).render('error.html')
})

// Try to match a request to a template, for example a request for /test
// would look for /app/views/test.html
// and /app/views/test/index.html

function renderPath(path, res, next) {
  // Try to render the path
  res.render(path, function (error, html) {
    if (!error) {
      // Success - send the response
      res.set({ 'Content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (!error.message.startsWith('template not found')) {
      // We got an error other than template not found - call next with the error
      next(error)
      return
    }
    if (!path.endsWith('/index')) {
      // Maybe it's a folder - try to render [path]/index.html
      renderPath(path + '/index', res, next)
      return
    }
    // We got template not found both times - call next to trigger the 404 page
    next()
  })
}

matchRoutes = function (req, res, next) {
  var path = req.path

  // Remove the first slash, render won't work with it
  path = path.substr(1)

  // If it's blank, render the root index
  if (path === '') {
    path = 'index'
  }

  renderPath(path, res, next)
}


function generateToken(length) {
  const tokenLength = Math.ceil(length / 2);
  const buffer = crypto.randomBytes(tokenLength);
  const token = buffer.toString('hex').slice(0, length);
  return token;
}

// Utility function to get the current date and time plus 30 minutes
function getExpiryDate() {
  const expiryDate = new Date();
  expiryDate.setMinutes(expiryDate.getMinutes() + 30);
  return expiryDate;
}

async function expirePreviousTokens(email) {
  const records = await base('Tokens').select({
    filterByFormula: `{Email} = '${email}'`
  }).firstPage();

  const deletePromises = records.map(record => {
    return base('Tokens').destroy(record.id);
  });

  return Promise.all(deletePromises);
}


// Utility function to send the magic link email
function sendMagicLinkEmail(token) {
  notify
  .sendEmail(process.env.magiclinkemailtemplateid, 'andy.jones@education.gov.uk', {
      personalisation: {
        token: token
      },
  })
  .then((response) => {return true})
  .catch((err) => console.log(err))
}



// Start the server

// Run application on configured port
if (config.env === 'development') {
  app.listen(config.port - 50, () => {
  });
}

app.listen(config.port)
