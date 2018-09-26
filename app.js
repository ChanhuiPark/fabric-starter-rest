const express = require("express");
const bodyParser = require("body-parser");
const app = express();
const logger = require('log4js').getLogger('app');
const jsonwebtoken = require('jsonwebtoken');
const jwt = require('express-jwt');
const cors = require('cors');
const SocketServer = require('socket.io');
const FabricStarterClient = require('./fabric-starter-client');
const fabricStarterClient = new FabricStarterClient();

const webappDir = process.env.WEBAPP_DIR || './webapp';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

// relax cors
// function corsCb(req, cb, next){
//   cb(null, {origin: req.headers.origin, credentials:true});
//   next();
// }
// app.options('*', cors(corsCb));
// app.use(cors(corsCb));

app.use(cors());
app.options('*', cors());

// serve web app as static
app.use('/webapp', express.static(webappDir));
logger.info('serving webapp at /webapp from ' + webappDir);

const asyncMiddleware = fn =>
  (req, res, next) => {
    // logger.debug('asyncMiddleware');
    Promise.resolve(fn(req, res, next))
      .catch(e => {
        logger.error('asyncMiddleware', e);
        res.status(500).json(e.message);
        next();
      });
  };

app.use(jwt({secret: fabricStarterClient.getSecret()}).unless({path: ['/', '/users', '/mspid']}));

app.use(async (req, res, next) => {
  await fabricStarterClient.init();
  if (req.user) {
    const login = req.user.sub;
    //TODO log request
    logger.debug('login', login);
    try {
      await fabricStarterClient.loginOrRegister(login);
    } catch(e) {
      logger.error('loginOrRegister', e);
      res.status(500).json(e.message);
    }
  }
  next();
});

const appRouter = (app) => {

  app.get('/', (req, res) => {
    res.status(200).send('Welcome to fabric-starter REST server');
  });

  app.get('/mspid', (req, res) => {
    res.json(fabricStarterClient.getMspid());
  });

  //TODO use for development only as it may expose sensitive data
  app.get('/config', (req, res) => {
    res.json(fabricStarterClient.getNetworkConfig());
  });

  app.get('/chaincodes', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.queryInstalledChaincodes());
  }));

  app.post('/chaincodes', asyncMiddleware(async (req, res, next) => {
    res.status(501).json('installing chaincode on peer not implemented');
  }));

  app.post('/users', asyncMiddleware(async (req, res, next) => {
    await fabricStarterClient.loginOrRegister(req.body.username, req.body.password);
    const token = jsonwebtoken.sign({sub: fabricStarterClient.user.getName()}, fabricStarterClient.getSecret());
    logger.debug('token', token);
    res.json(token);
  }));

  app.get('/channels', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.queryChannels());
  }));

  app.post('/channels', asyncMiddleware(async (req, res, next) => {
    res.status(501).json('adding channel not implemented');
  }));

  app.get('/channels/:channelId', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.queryInfo(req.params.channelId));
  }));

  app.get('/channels/:channelId/orgs', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.getOrganizations(req.params.channelId));
  }));

  app.get('/channels/:channelId/peers', asyncMiddleware(async (req, res, next) => {
    res.json(fabricStarterClient.getPeersForOrgOnChannel(req.params.channelId));
  }));

  app.get('/orgs/:org/peers', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.getPeersForOrg(req.params.org));
  }));

  app.post('/channels/:channelId/orgs', asyncMiddleware(async (req, res, next) => {
    res.status(501).json('adding organization to channel not implemented');
  }));

  app.get('/channels/:channelId/blocks/:number', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.queryBlock(req.params.channelId, parseInt(req.params.number)));
  }));

  app.get('/channels/:channelId/transactions/:id', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.queryTransaction(req.params.channelId, req.params.id));
  }));

  app.get('/channels/:channelId/chaincodes', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.queryInstantiatedChaincodes(req.params.channelId));
  }));

  app.post('/channels/:channelId/chaincodes', asyncMiddleware(async (req, res, next) => {
    res.status(501).json('instantiating chaincode on channel not implemented');
  }));

  app.get('/channels/:channelId/chaincodes/:chaincodeId', asyncMiddleware(async (req, res, next) => {
    let ret = await fabricStarterClient.query(req.params.channelId, req.params.chaincodeId,
      req.query.fcn, JSON.parse(req.query.args), req.query.targets);

    if(ret[0].startsWith('Error')) {
      throw new Error(ret[0]);
    }

    res.json(ret);
  }));

  app.post('/channels/:channelId/chaincodes/:chaincodeId', asyncMiddleware(async (req, res, next) => {
    res.json(await fabricStarterClient.invoke(req.params.channelId, req.params.chaincodeId,
      req.body.fcn, req.body.args, req.body.targets));
  }));


};

appRouter(app);

const server = app.listen(process.env.PORT || 3000, function () {
  logger.info('started fabric-starter rest server on port', server.address().port);
});

async function startSocketServer() {
  const io = new SocketServer(server, {origins: '*:*'});

  const channels = await fabricStarterClient.queryChannels();

  channels.map(c => {return c.channel_id;}).forEach(async channelId => {
    await fabricStarterClient.registerBlockEvent(channelId, block => {
      logger.debug(`block ${block.number} on ${block.channel_id}`);
      io.emit('chainblock', block);
    }, e => {
      logger.error('registerBlockEvent', e);
    });
    logger.debug(`registered for block event on ${channelId}`);
  });
}

startSocketServer().then(() => {
  logger.info('started socket server');
});