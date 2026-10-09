const express = require('express');
const { chromium } = require('playwright');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const UNAME    = process.env.UNAME    || 'admin';
const UPASS    = process.env.UPASS    || 'password123';
const PORT     = process.env.PORT     || 3000;
const DATA_FILE = path.join(__dirname, 'tasks.json');

app.use(bodyParser.json());

const auth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).set('WWW-Authenticate', 'Basic realm="monitor"').send('Unauthorized');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'basic') {
        return res.status(400).send('Invalid Authorization header format');
    }

    try {
        const decoded = Buffer.from(parts[1], 'base64').toString();
        const [user, pass] = decoded.split(':');

        if (user === UNAME && pass === UPASS) {
            next();
        } else {
            res.status(401).send('Invalid Credentials');
        }
    } catch (err) {
        res.status(400).send('Invalid Base64 encoding');
    }
};
app.use(auth); 
app.use(express.static('public'));

let tasks = [];
if (fs.existsSync(DATA_FILE)) {
    tasks = JSON.parse(fs.readFileSync(DATA_FILE));
}

const saveTasks = () => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2));
};

const scheduledJobs = {};

async function checkUrl(task) {
    console.log(`[${new Date().toISOString()}] Check: ${task.name}`);
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.setDefaultTimeout(30000);

        const start = Date.now();
        const response = await page.goto(task.url, { waitUntil: 'domidle' });
        const duration = Date.now() - start;

        const statusCode = response ? response.status() : 'ERROR';
        const isUp = response && response.ok() ? 'up' : 'down';
        
        task.lastCheck = new Date().toISOString();
        task.status = isUp;
        task.lastStatusCode = statusCode;
        task.responseTime = duration;
        
        await browser.close();
    } catch (error) {
        task.lastCheck = new Date().toISOString();
        task.status = 'down';
        task.lastError = error.message;
        if (browser) await browser.close();
    }
    saveTasks();
}

function refreshSchedules() {
    Object.keys(scheduledJobs).forEach(id => {
        scheduledJobs[id].stop();
        delete scheduledJobs[id];
    });

    tasks.forEach(task => {
        scheduledJobs[task.id] = cron.schedule(task.interval, () => {
            checkUrl(task);
        });
    });
}

app.get('/api/config', (req, res) => {
    const authToken = Buffer.from(`${UNAME}:${UPASS}`).toString('base64');
    res.json({ authToken });
});

app.get('/api/tasks', auth, (req, res) => {
    res.json(tasks);
});

app.post('/api/tasks', auth, (req, res) => {
    const newTask = {
        id: Date.now().toString(),
        name: req.body.name,
        url: req.body.url,
        interval: req.body.interval || '* * * * *',
        status: 'pending',
        lastCheck: null
    };
    tasks.push(newTask);
    saveTasks();
    refreshSchedules();
    res.status(201).json(newTask);
});

app.delete('/api/tasks/:id', auth, (req, res) => {
    tasks = tasks.filter(t => t.id !== req.params.id);
    if (scheduledJobs[req.params.id]) {
        scheduledJobs[req.params.id].stop();
        delete scheduledJobs[req.params.id];
    }
    saveTasks();
    refreshSchedules();
    res.send(204);
});

refreshSchedules();
app.listen(PORT, () => {
    console.log(`http server is running on port:${PORT}!`);
});
