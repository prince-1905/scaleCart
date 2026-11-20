-- Sends a new declarative config to Kong's admin API (DB-less "POST /config"), from inside the container (the image
-- has no curl):   resty /kong/reload.lua /tmp/kong-new.yml
-- Prints the HTTP status and how long Kong took to apply it.
local http = require "resty.http"
local cjson = require "cjson.safe"

local file = assert(io.open(arg[1], "r"))
local yaml = file:read("*a")
file:close()

local started = ngx.now()
local res, err = http.new():request_uri("http://127.0.0.1:8001/config", {
  method = "POST",
  body = cjson.encode({ config = yaml }),
  headers = { ["Content-Type"] = "application/json" },
})
ngx.update_time()
if not res then
  print("error: ", err)
  os.exit(1)
end
print(res.status, " ", string.format("%.3f", ngx.now() - started), " s")
