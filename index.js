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
    res.render('invalid-link')
  } else {

    // Token is valid, set the session cookie and redirect to the dashboard
    res.cookie('session', token, { maxAge: 3 * 60 * 60 * 1000});

    await wait(500);

    req.session.email = records[0].get('Email');
    req.session.token = records[0].get('Token');

    // Delete the token
    await expirePreviousTokens(records[0].get('Email'))

    res.redirect('/overview');
  }
});

app.get('/overview', authenticate, async (req, res) => {

  const user = await getUserData(req.session.email);

  res.render('auth-views/overview/index', { user });
});

app.get('/skills', authenticate, async (req, res) => {

  console.log(req.session.email)

  const user = await getUserData(req.session.email);


  console.log(user)

  const framework = await getRoleSkillsView(user.Role + " " + user.Grade);
  const userSkill = await getUserSkillsAll(user.Email);
  const userPlans = await getUserPlans(user.Email);
  res.render('auth-views/skills/overview', { user, framework, userSkill, userPlans });
});

app.get('/skills/:id', authenticate, async (req, res) => {
  const user = await getUserData(req.session.email);

  var skillID = req.params.id;

  var nextGrade = "";

  if (user.Grade === "EA") {
    nextGrade = "HEO";
  }

  if (user.Grade === "HEO") {
    nextGrade = "SEO";
  }

  if (user.Grade === "SEO") {
    nextGrade = "G7";
  }

  if (user.Grade === "G7") {
    nextGrade = "G6 Lead";
  }

  if (user.Grade === "G6 Lead") {
    nextGrade = "G6 HoP";
  }

  const framework = await getRoleSkillsView(user.Role + " " + user.Grade);
  const roleSkill = await getRoleSkillBySkillIDX(skillID);
  const nextFramework = await getRoleSkillsView(user.Role + " " + nextGrade);
  const userSkill = await getUserSkills(user.Email, skillID);

  const plan = await getPlans(user.Email, skillID);

  res.render('auth-views/skills/index', { user, framework, nextFramework, nextGrade, userSkill, plan, roleSkill });
});

app.get('/plan', authenticate, async (req, res) => {

  const user = await getUserData(req.session.email);
  const framework = await getRoleSkillsView(user.Role + " " + user.Grade);
  const userPlans = await getUserPlan(user.Email);
  const userSkills = await getUserSkillsAll(user.Email);
  const actions = await getUserPlanActions(user.Email);

  res.render('auth-views/plan/index', { user, framework, userPlans, userSkills, actions });
});

app.get('/profile', authenticate, async (req, res) => {
    const user = await getUserData(req.session.email);
  res.render('auth-views/profile/index', { user });
});

app.get('/profile/name', authenticate, async (req, res) => {
    const user = await getUserData(req.session.email);
  var updated = req.query.u;
  res.render('auth-views/profile/name', { user, updated });
});

app.get('/profile/grade', authenticate, async (req, res) => {
    const user = await getUserData(req.session.email);
  var updated = req.query.u;
  res.render('auth-views/profile/grade', { user, updated });
});

app.get('/profile/role', authenticate, async (req, res) => {
    const user = await getUserData(req.session.email);
  var updated = req.query.u;
  res.render('auth-views/profile/role', { user, updated });
});

app.post('/profile/name', authenticate, async (req, res) => {
  const user = await getAllUserData(req.session.email);
  updateUserName(user.id, req.body.firstName, req.body.LastName)
  await wait(500);
  res.redirect('/profile/name?u=1');
});

app.post('/profile/grade', authenticate, async (req, res) => {
  const user = await getAllUserData(req.session.email);
  updateGrade(user.id, req.body.grade)
  await wait(500);
  res.redirect('/profile/grade?u=1');
});

app.post('/profile/role', authenticate, async (req, res) => {
  const user = await getAllUserData(req.session.email);
  updateRole(user.id, req.body.role)
  await wait(500);
  res.redirect('/profile/role?u=1');
});

app.post('/plan/add-update', authenticate, async (req, res) => {
  const user = await getAllUserData(req.session.email);
  const update = req.body.actionupdate;
  const planID = req.body.planid;

  addPlanAction(update, planID)
  await wait(500);
  res.redirect('/plan');
});


async function updateUserName(userId, firstName, lastName) {
  try {
    const updatedRecord = await base('Users').update(userId, {
      FirstName: firstName,
      LastName: lastName
    });

    // Process the updated record as needed
    return updatedRecord;
  } catch (error) {
    // Handle error
    console.error('Error updating user name in Airtable:', error);
    throw error;
  }
}

async function updateGrade(userId, grade) {
  try {
    const updatedRecord = await base('Users').update(userId, {
      Grade: grade
    });

    // Process the updated record as needed
    return updatedRecord;
  } catch (error) {
    // Handle error
    console.error('Error updating user name in Airtable:', error);
    throw error;
  }
}

async function updateRole(userId, role) {
  try {
    const updatedRecord = await base('Users').update(userId, {
      Role: role
    });

    // Process the updated record as needed
    return updatedRecord;
  } catch (error) {
    // Handle error
    console.error('Error updating user name in Airtable:', error);
    throw error;
  }
}


app.post('/save-current', authenticate, async (req, res) => {
    const user = await getUserData(req.session.email);
  const framework = await getRoleSkillBySkillID(req.body.skillid);
  addUserSkill(process.env.email, framework[0].fields.Display, req.body.currentlevel, req.body.comments, parseInt(req.body.skillid))
  res.redirect('/skills/' + req.body.skillid);
});

app.post('/add-plan', authenticate, async (req, res) => {
    const user = await getUserData(req.session.email);
  const framework = await getRoleSkillBySkillID(req.body.actionskillid);
  addUserPlan(process.env.email, req.body.action, parseInt(req.body.actionskillid))
  res.redirect('/skills/' + req.body.actionskillid);
});

async function getRoleSkillBySkillID(skillID) {
  try {
    const records = await base('RoleSkills')
      .select({
        filterByFormula: `{SkillID} = '${skillID}'`
      })
      .all();

    // Process the retrieved records as needed
    return records;
  } catch (error) {
    // Handle error
    console.error('Error retrieving role skills from Airtable:', error);
    throw error;
  }
}

async function getRoleSkillBySkillIDX(skillID) {
  try {
    const records = await base('RoleSkills')
      .select({
        filterByFormula: `{SkillID} = '${skillID}'`,
        maxRecords: 1
      })
      .firstPage();

    if (records.length > 0) {
      const userSkill = records[0];
      // Process the userSkill record as needed
      return userSkill;
    } else {
      return null; // No matching record found
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user skill from Airtable:', error);
    throw error;
  }
}

async function getUserPlan(email) {
  try {
    const records = await base('Plans')
      .select({
        filterByFormula: `{Email} = '${email}'`,
        sort: [{ field: 'SkillID', direction: 'asc' }]
      })
      .all();

    if (records.length > 0) {
      const r = records;
      // Process the userSkill record as needed
      return r;
    } else {
      return null; // No matching record found
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user skill from Airtable:', error);
    throw error;
  }
}

async function getUserPlanActions(email) {
  try {
    const records = await base('PlanActions')
      .select({
        filterByFormula: `{Plans} = '${email}'`,
        sort: [{ field: 'Created', direction: 'desc' }]
      })
      .all();

    if (records.length > 0) {
      const r = records;
      // Process the userSkill record as needed
      return r;
    } else {
      return null; // No matching record found
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user skill from Airtable:', error);
    throw error;
  }
}

async function getRoleSkillsView(viewName) {
  try {
    const records = await base('RoleSkills')
      .select({
        view: viewName
      })
      .all();

    return records;
  } catch (error) {
    console.error('Error retrieving view from Airtable:', error);
    return null;
  }
}

// Sign out route
app.get('/sign-out', (req, res) => {
  req.session.destroy(); // Destroy the session
  res.clearCookie('session'); // Clear the session cookie

  res.redirect('/signed-out'); // Redirect to sign-out confirmation page
});

function authenticate(req, res, next) {
  if (config.env === 'development') {
    next();
  }
  else {
    if (req.session && req.session.email) {
      // User is authenticated, proceed to the next middleware or route handler
      next();
    } else {
      // User is not authenticated, redirect to the sign-in page or display an error
      res.redirect('/sign-in');
    }
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

async function addUserSkill(email, expectedLevel, currentLevel, comments, skillID) {
  try {
    const newRecord = await base('UserSkill').create({
      Email: email,
      ExpectedLevel: expectedLevel,
      CurrentLevel: currentLevel,
      Comments: comments,
      SkillID: skillID
    });

    // Process the new record as needed
    return newRecord;
  } catch (error) {
    // Handle error
    console.error('Error adding user skill to Airtable:', error);
    throw error;
  }
}

async function addPlanAction(action, planID) {
  try {
    const newRecord = await base('PlanActions').create({
      Action: action,
      Plans: [planID]
    });

    // Process the new record as needed
    return newRecord;
  } catch (error) {
    // Handle error
    console.error('Error adding user plan to Airtable:', error);
    throw error;
  }
}

async function addUserPlan(email, plan, skillID) {
  try {
    const newRecord = await base('Plans').create({
      Email: email,
      Plan: plan,
      SkillID: skillID
    });

    // Process the new record as needed
    return newRecord;
  } catch (error) {
    // Handle error
    console.error('Error adding user plan to Airtable:', error);
    throw error;
  }
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
    .then((response) => { return true })
    .catch((err) => console.log(err))
}

async function getAllUserData(email) {
  try {
    const records = await base('Users').select({
      filterByFormula: `{Email} = '${email}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 1) {
      const userData = records[0]
      return userData;
    } else {
      // User not found
      return null;
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user data:', error);
    throw error;
  }
}

async function getUserData(email) {
  try {
    const records = await base('Users').select({
      filterByFormula: `{Email} = '${email}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length === 1) {
      const userData = records[0].fields;
      return userData;
    } else {
      // User not found
      return null;
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user data:', error);
    throw error;
  }
}

async function getUserSkillsAll(email) {
  try {
    const records = await base('UserSkill').select({
      filterByFormula: `{Email} = '${email}'`,
      sort: [{ field: 'Created', direction: 'desc' }]
    }).firstPage();

    if (records.length > 0) {
      return records;
    } else {
      return null; // No matching records found
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user skills:', error);
    throw error;
  }
}

async function getUserSkills(email, skillID) {
  try {
    const records = await base('UserSkill').select({
      filterByFormula: `AND({Email} = '${email}', {SkillID} = '${skillID}')`,
      sort: [{ field: 'Created', direction: 'desc' }],
      maxRecords: 1
    }).firstPage();

    if (records.length > 0) {
      return records[0];
    } else {
      return null; // No matching records found
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user skills:', error);
    throw error;
  }
}

async function getPlans(email, skillID) {
  try {
    const records = await base('Plans').select({
      filterByFormula: `AND({Email} = '${email}', {SkillID} = '${skillID}')`,
      sort: [{ field: 'Created', direction: 'desc' }]
    }).firstPage();

    if (records.length > 0) {
      return records;
    } else {
      return null; // No matching records found
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user skills:', error);
    throw error;
  }
}


async function getUserPlans(email) {
  try {
    const records = await base('Plans').select({
      filterByFormula: `{Email} = '${email}'`,
      sort: [{ field: 'Created', direction: 'desc' }]
    }).firstPage();

    if (records.length > 0) {
      return records;
    } else {
      return null; // No matching records found
    }
  } catch (error) {
    // Handle error
    console.error('Error retrieving user skills:', error);
    throw error;
  }
}

function wait(waitTime) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(true)
    }, waitTime)
  })
}


// Start the server

// Run application on configured port
if (config.env === 'development') {
  app.listen(config.port - 50, () => {
  });
}

app.listen(config.port)
