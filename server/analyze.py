import csv
from collections import Counter, defaultdict

file_path = 'c:/Users/tharu/Desktop/todo-app/server/data/dataset.csv'

with open(file_path, 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    rows = list(reader)

print(f"Total rows: {len(rows)}")
print(f"Columns: {list(rows[0].keys())}\n")

# Distribution of target: is_delayed and delay_status
is_delayed_counts = Counter(r['is_delayed'] for r in rows)
delay_status_counts = Counter(r['delay_status'] for r in rows)
print(f"is_delayed distribution: {dict(is_delayed_counts)}")
print(f"delay_status distribution: {dict(delay_status_counts)}")

# Priority vs Delay
priority_stats = defaultdict(lambda: {'total': 0, 'delayed': 0})
for r in rows:
    p = r['Priority']
    priority_stats[p]['total'] += 1
    if r['is_delayed'] == '1':
        priority_stats[p]['delayed'] += 1

print("\n--- Priority vs Delay Rate ---")
for p, s in sorted(priority_stats.items()):
    rate = (s['delayed'] / s['total']) * 100 if s['total'] else 0
    print(f"{p:10}: {s['delayed']}/{s['total']} ({rate:.1f}%)")

# Category vs Delay
category_stats = defaultdict(lambda: {'total': 0, 'delayed': 0})
for r in rows:
    c = r['Category']
    category_stats[c]['total'] += 1
    if r['is_delayed'] == '1':
        category_stats[c]['delayed'] += 1

print("\n--- Category vs Delay Rate ---")
for c, s in sorted(category_stats.items()):
    rate = (s['delayed'] / s['total']) * 100 if s['total'] else 0
    print(f"{c:25}: {s['delayed']}/{s['total']} ({rate:.1f}%)")

# Shifted vs Delay
shifted_stats = defaultdict(lambda: {'total': 0, 'delayed': 0})
for r in rows:
    s = r['is_shifted']
    shifted_stats[s]['total'] += 1
    if r['is_delayed'] == '1':
        shifted_stats[s]['delayed'] += 1

print("\n--- is_shifted vs Delay Rate ---")
for s, st in sorted(shifted_stats.items()):
    rate = (st['delayed'] / st['total']) * 100 if st['total'] else 0
    print(f"Shifted={s}: {st['delayed']}/{st['total']} ({rate:.1f}%)")

# Shift Reason vs Delay
reason_stats = defaultdict(lambda: {'total': 0, 'delayed': 0})
for r in rows:
    reason = r.get('Shift Reason', 'None') or 'None'
    reason_stats[reason]['total'] += 1
    if r['is_delayed'] == '1':
        reason_stats[reason]['delayed'] += 1

print("\n--- Shift Reason vs Delay Rate ---")
for r, st in sorted(reason_stats.items()):
    rate = (st['delayed'] / st['total']) * 100 if st['total'] else 0
    print(f"{r:25}: {st['delayed']}/{s['total']} ({rate:.1f}%)")

# Repeated vs Delay
rep_stats = defaultdict(lambda: {'total': 0, 'delayed': 0})
for r in rows:
    rep = r['is_repeated']
    rep_stats[rep]['total'] += 1
    if r['is_delayed'] == '1':
        rep_stats[rep]['delayed'] += 1

print("\n--- is_repeated vs Delay Rate ---")
for rep, st in sorted(rep_stats.items()):
    rate = (st['delayed'] / st['total']) * 100 if st['total'] else 0
    print(f"Repeated={rep}: {st['delayed']}/{st['total']} ({rate:.1f}%)")

# Lead days vs duration
lead_days_stats = defaultdict(list)
duration_stats = defaultdict(list)
for r in rows:
    try:
        lead = float(r['allocated_lead_days'])
        dur = float(r['actual_duration_days'])
        lead_days_stats[r['is_delayed']].append(lead)
        duration_stats[r['is_delayed']].append(dur)
    except:
        pass

for k in ['0', '1']:
    leads = lead_days_stats[k]
    durs = duration_stats[k]
    avg_lead = sum(leads) / len(leads) if leads else 0
    avg_dur = sum(durs) / len(durs) if durs else 0
    status_label = 'Not Delayed (0)' if k == '0' else 'Delayed (1)'
    print(f"\n{status_label}: Avg Allocated Lead Days = {avg_lead:.2f}, Avg Actual Duration = {avg_dur:.2f}")

