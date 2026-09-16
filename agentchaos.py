#!/usr/bin/env python3
import argparse, json, os, signal, subprocess, sys, time, uuid
from pathlib import Path

def log(path, event, **data):
    rec={"ts":time.time(),"event":event,**data}
    with open(path,"a",encoding="utf-8") as f: f.write(json.dumps(rec,ensure_ascii=False)+"\n")
    print(f"[{event}] {data}")

def run(spec):
    run_id=str(uuid.uuid4()); root=Path(spec.get("workspace", ".agentchaos-runs"))/run_id
    root.mkdir(parents=True,exist_ok=True); events=root/"events.jsonl"; work=root/"workspace"; work.mkdir()
    target=spec["target"]; env=os.environ.copy(); env.update(target.get("env",{})); env["AGENTCHAOS_RUN_ID"]=run_id
    cmd=target["command"] if isinstance(target["command"],list) else ["/bin/sh","-lc",target["command"]]
    log(events,"run_started",run_id=run_id,command=cmd)
    # Keep the control loop non-blocking; production adapters should stream PTY events.
    p=subprocess.Popen(cmd,cwd=work,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    faults=sorted(spec.get("faults",[]),key=lambda x:x.get("at",0)); start=time.time(); done=set()
    while p.poll() is None:
        now=time.time()-start
        for i,f in enumerate(faults):
            if i in done or now < f.get("at",0): continue
            done.add(i); typ=f["type"]; log(events,"fault_injected",fault=typ,config=f)
            if typ=="process_kill": os.killpg(p.pid,signal.SIGKILL)
            elif typ=="file_edit":
                q=work/f["path"]; q.parent.mkdir(parents=True,exist_ok=True); q.write_text(f.get("content","chaos\n"),encoding="utf-8")
            elif typ=="network_delay": time.sleep(float(f.get("duration",1)))
        time.sleep(.05)
    log(events,"run_finished",exit_code=p.returncode)
    assertions=spec.get("assertions",[]); results=[]
    for a in assertions:
        ok=True
        if a=="exit_zero": ok=p.returncode==0
        if a.startswith("file_exists:"): ok=(work/a.split(":",1)[1]).exists()
        results.append({"assertion":a,"passed":ok})
    print(json.dumps({"run_id":run_id,"exit_code":p.returncode,"results":results,"events":str(events)},ensure_ascii=False,indent=2))
    return 0 if all(x["passed"] for x in results) else 1

if __name__=="__main__":
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="op",required=True); r=sub.add_parser("run"); r.add_argument("spec")
    a=ap.parse_args(); sys.exit(run(json.loads(Path(a.spec).read_text()) if a.spec.endswith(".json") else __import__('yaml').safe_load(Path(a.spec).read_text())))
