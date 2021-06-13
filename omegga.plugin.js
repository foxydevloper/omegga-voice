const express = require("express");
const https = require("https");
const io = require("socket.io");
const fs = require("fs");
const pem = require("pem").promisified;
const {ExpressPeerServer} = require("peer");

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ123456789";

module.exports = class VoicePlugin {
  constructor(omegga, config, store) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;

    this.players = [];
  }

  randomCode(length) {
    let code = "";
    for (let i = 0; i < length; i++)
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return code;
  }

  // thanks cake
  getTransforms() {
    // patterns to match console logs
    const rotRegExp = /(?<index>\d+)\) CapsuleComponent .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.CollisionCylinder\.RelativeRotation = \(Pitch=(?<pitch>[\d\.-]+),Yaw=(?<yaw>[\d\.-]+),Roll=(?<roll>[\d\.-]+)\)$/;
    const crouchedRegExp = /(?<index>\d+)\) BP_FigureV2_C .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.bIsCrouched = (?<crouched>(True|False))$/;
    const emotePlayerRegExp = /(?<index>\d+)\) BP_FigureV2_C .+?PersistentLevel\.(?<pawn>BP_FigureV2_C_\d+)\.ActiveEmotes =$/;
    const emoteStateRegExp = /^\t(?<index>\d+): BlueprintGeneratedClass'(.+)Emotes\/BP_Emote_(?<emote>\w+).\w+'$/;

    // run the pattern commands
    return Promise.all([
      this.omegga.getAllPlayerPositions(),
      this.omegga.watchLogChunk('GetAll SceneComponent RelativeRotation Name=CollisionCylinder', rotRegExp, {first: 'index'}),
      this.omegga.watchLogChunk('GetAll BP_FigureV2_C bIsCrouched', crouchedRegExp, {first: 'index'}),
      this.omegga.watchLogArray('GetAll BP_FigureV2_C ActiveEmotes', emotePlayerRegExp, emoteStateRegExp),
    ]);
  }

  async sendTransforms() {
    const transforms = [];

    const transformData = await this.getTransforms();
    for (const transform of transformData[0]) {
      const rot = transformData[1].find(r => r.groups.pawn == transform.pawn);
      const player = this.players.find(p => p.user == transform.player.name);
      const peerId = player?.peerId;
      transforms.push({
        name: transform.player.name,
        x: transform.pos[0],
        y: transform.pos[1],
        z: transform.pos[2],
        yaw: parseFloat(rot.groups.yaw),
        peerId
      });
    }

    this.io.emit("transforms", transforms);
  }

  async init() {
    // get https working
    // this code is borrowed from the omegga source
    if (!require("hasbin").sync("openssl")) {
      console.log("Can't start voice server without openssl installed!");
      return;
    }

    let ssl = {};
    if (fs.existsSync("./cert.pem")) {
      console.log("Using existing SSL keys");

      ssl = {cert: fs.readFileSync("./cert.pem"), key: fs.readFileSync("./key.pem")};
    } else {
      console.log("Generating new SSL keys");

      const keys = await pem.createCertificate({days: 360, selfSigned: true});
      ssl = {cert: keys.certificate, key: keys.serviceKey};

      // write out
      fs.writeFileSync("./cert.pem", keys.certificate);
      fs.writeFileSync("./key.pem", keys.serviceKey);
    }

    // set up the web server
    this.web = express();
    this.server = https.createServer(ssl, this.web);
    this.io = io(this.server);

    const server = this.server;
    const peerjsWrapper = {on(event, callback) {
      if (event === 'upgrade') {
        server.on('upgrade', (req, socket, head) => {
          if (!req.url.startsWith('/socket.io/'))
            callback(req, socket, head);
        })
      } else {
        server.on(...arguments);
      }
    }};

    this.peer = ExpressPeerServer(peerjsWrapper);

    this.web.set("trust proxy", 1);

    // serve public folder
    this.web.use("/peerjs", this.peer);
    this.web.use(express.static("plugins/omegga-voice/public"));

    // set up socket io
    this.io.on("connection", (socket) => {
      const code = this.randomCode(6);
      
      // the socket is ready for the server
      socket.on("hi", async (data) => {
        const serverStatus = await this.omegga.getServerStatus();

        // client must link with their user in-game
        socket.emit("hi", {code, serverName: serverStatus.serverName, hostName: this.omegga.host.name, config: {
          maxVoiceDistance: this.config["max-distance"] * 10,
          falloffFactor: this.config["falloff-factor"],
          useProximity: this.config["proximity"],
          usePanning: this.config["panning"]
        }});

        const player = {socket, code, user: null, peerId: data.peerId};
        this.players.push(player);
      });

      socket.on("disconnect", () => {
        // remove this socket from the players array
        for (let i = this.players.length - 1; i >= 0; i--) {
          if (this.players[i].socket == socket) {
            this.players.splice(i, 1);
          }
        }
      });
    });

    // start listening
    this.server.listen(this.config["port"], () => {
      console.log(`Voice chat webserver active at http://localhost:${this.config["port"]}`);
    });

    // start sending transforms regularly
    this.transformInterval = setInterval(async () => {
      await this.sendTransforms();
    }, 200);

    // when a player leaves, clean them up and inform all other clients
    this.omegga.on("leave", async (player) => {
      for (let i = this.players.length - 1; i >= 0; i--) {
        if (this.players[i].user == player.name) {
          this.players[i].socket.emit("bye");
          this.io.emit("peer leave", {name: player.name, peerId: this.players[i].peerId});
          this.players.splice(i, 1);
        }
      }
    });

    this.omegga.on("cmd:auth", async (user, code) => {
      for (const player of this.players) {
        if (player.code == code && player.user == null) {
          // found a working player code, attach it
          player.user = user;
          this.omegga.whisper(user, "<color=\"ff0\">Authentication successful.</>");

          // inform our socket
          player.socket.emit("authenticated", user);

          // tell the other sockets that we've got a new player
          this.io.emit("peer join", {name: user, peerId: player.peerId});

          return;
        }
      }
      this.omegga.whisper(user, "<color=\"f00\">Invalid authentication code.</>");
    });

    return {registeredCommands: ["auth"]};
  }

  async stop() {}
}