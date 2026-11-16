"""Publish saved Carry artifacts without changing the retained carry method.
The separate upstream writer owns source qualification. A new complete date is
admitted only against an explicit, reviewed physical-session calendar policy.
Until that registry is ready this job records its check but retains the baseline.
"""
import copy, datetime as dt, hashlib, json, pathlib
ROOT=pathlib.Path(__file__).resolve().parent

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def advance(saved, candidates, recent, policy, checked_at):
    out=copy.deepcopy(saved)
    retained=out['carry']; last=retained[-1]['to_date']; reasons=[]; added=0
    if not policy.get('ready'):
        reasons.append('Current state/session calendar is awaiting verification. No newer date admitted.')
    else:
        states=policy['states']
        for t in candidates:
            if t['to_date']<=last: continue
            expected_next=(dt.date.fromisoformat(last)+dt.timedelta(days=1)).isoformat()
            if t['from_date']!=last or t['to_date']!=expected_next:
                reasons.append('Non-contiguous candidate date.');break
            day=dt.date.fromisoformat(t['to_date']); actual={s['state']:s for s in t['states']}
            missing=[]
            for state, spec in states.items():
                required=spec['sessions'] if day.weekday() in spec['weekdays'] else []
                found=[x['tod'] for x in actual.get(state,{}).get('d2_draws',[])]
                if len(found)!=len(set(found)) or set(found)!=set(required):
                    missing.append(state)
            if set(actual)-set(states):missing.append('unexpected state')
            if missing:
                reasons.append('Incomplete or conflicting session coverage for '+t['to_date']+': '+', '.join(missing));break
            if not recent.get(t['to_date']):
                reasons.append('Missing saved draw index for candidate.');break
            retained.append(copy.deepcopy(t));out['recent'][t['to_date']]=recent[t['to_date']]
            last=t['to_date'];added+=1
    out['schema']=1
    out['status']={'checked_at_utc':checked_at,'saved_through':last,
        'connection':'connected','state':'updated' if added else 'held',
        'new_transitions':added,'candidate_through':candidates[-1]['to_date'] if candidates else None,
        'detail':' '.join(reasons) if reasons else 'Saved complete dates passed the session calendar gate.',
        'history_preserved':True,'method':'existing-carry-v1',
        'coverage':'Retained saved history; no claim of all-state current-day completeness.'}
    out['sha256']={'carry':digest(out['carry']),'recent':digest(out['recent'])}
    return out

if __name__=='__main__':
    load=lambda n:json.loads((ROOT/n).read_text())
    saved=load('saved-carry.json');before=copy.deepcopy(saved['carry'])
    out=advance(saved,load('carry-data.json'),load('recent-draws.json'),load('carry-session-policy.json'),dt.datetime.now(dt.timezone.utc).isoformat())
    assert out['carry'][:len(before)]==before,'retained history changed'
    (ROOT/'saved-carry.json').write_text(json.dumps(out,separators=(',',':')))
    print(json.dumps(out['status']))
