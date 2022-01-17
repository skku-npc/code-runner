const fs = require("fs");
const express = require("express");
const app = express();
const server = require("http").createServer(app);

const io = require("socket.io")(server, {
    cors: {
        origin: "*",
        credentials: true
    }
});
const pty = require("node-pty");
const jsonParser = require('body-parser').json();

const logging = require('./winston');
const morgan = require('morgan');
const combined = ':remote-addr - :remote-user ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"' 
const morganFormat = process.env.NODE_ENV !== "production" ? "dev" : combined;
// morgan 출력 형태 server.env에서 NODE_ENV 설정 production : 배포 dev : 개발

const compiler = require("./compiler");
const cleanUp = require("./file_manager").cleanUp;
const { purifyPath, makeRunFormat, checkLanguage }  = require("./formatter");
const BASE_DIR = require("./constants").WORKSPACE_BASE;

let server_logger = new logging("server")
let compile_logger = new logging("compile")
let run_logger = new logging("run")

// TODO: redirect errors to log file
app.use(require('cors')());
app.use(jsonParser);
app.use( morgan(morganFormat, {stream : logger.stream}) );

app.use( morgan(morganFormat, {stream : server_logger.stream}) );

app.post("/compile", async (req, res) => {
    const dir = Math.random().toString(36).substr(2,11);
    const lang = req.body.lang;
    const code = req.body.code;
    try {
        await compiler.compile(dir, lang, code);
        res.send({"status": 1, "output": dir});
    } catch (err) {
        try {
            await cleanUp(dir);
        } catch (cleanupErr) {
            console.log(cleanupErr);
            compile_logger.error(cleanupErr);
        }
        console.log(err);
        compile_logger.error(err);

        res.send({"status": 0, "output": err});
    }
})

//TODO: handshake, Run 분리
io.on("connection", async(socket) => {
    try {
        var dir = socket.handshake.query['token'];
        var lang = socket.handshake.query['lang'];
        await purifyPath(dir).then((value) => { dir = value; })
        await checkLanguage(lang).then((value) => { if(!value) throw new Error("Unsupported language"); })

        if(!fs.existsSync(BASE_DIR + dir)) {
            socket.disconnect(); 
        } else {
            const shell = pty.spawn("/usr/lib/judger/libjudger.so", makeRunFormat(dir, lang));
            shell.on('data', (data) => {
                console.log("%s", data);
                run_logger.info(data);
                socket.emit("stdout", data);
            });
            socket.on("stdin", (input) => {
                console.log("%s", input);
                run_logger.info(data);
                shell.write(input + "\n");
            });
            shell.on("exit", async(code) => {
                console.log("child process exited with code " + code);
                console.log(dir);
                if(dir) {
                    try {
                        await cleanUp(dir);
                    } catch (err) {
                        console.log(err);
                        run_logger.error(err);
                    } finally {
                        socket.emit("exited");
                        socket.disconnect();
                    }
                }
            });
        }
    } catch (err) {
        console.log(err);
        run_logger.error(err);
        socket.disconnect();
    }
});

server.listen(3000, () => {
    console.log("Server opened");
    server_logger.info("Server Start Listening on port 3000");
});