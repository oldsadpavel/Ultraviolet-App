const selfsigned = require("selfsigned");
const https = require("https");
const tls = require("tls");
const pems = selfsigned.generate([{name:"commonName",value:"deepl.com"}], {days:3650, keySize:2048, algorithm:"sha256", altNames:[{type:2,value:"deepl.com"},{type:2,value:"*.deepl.com"}]});
console.log("key len:", (pems.private||"").length, "cert len:", (pems.cert||"").length);
console.log("key head:", (pems.private||"").slice(0,40));
console.log("cert head:", (pems.cert||"").slice(0,40));
const srv = https.createServer({key:pems.private, cert:pems.cert}, (q,r)=>{ r.end("ok"); });
srv.listen(9443, ()=>{
  const c = tls.connect({host:"127.0.0.1",port:9443,servername:"www.deepl.com",rejectUnauthorized:false}, ()=>{
    console.log("LOOPBACK TLS OK proto=", c.getProtocol(), "cipher=", c.getCipher().name);
    c.end(); srv.close(); process.exit(0);
  });
  c.on("error", e=>{ console.log("LOOPBACK TLS ERR:", e.message); srv.close(); process.exit(1); });
});
srv.on("error", e=>{ console.log("SERVER ERR:", e.message); process.exit(1); });
setTimeout(()=>{ console.log("timeout"); process.exit(1); }, 6000);
