import sys
MARK = '/*__DATA__*/' + ';'          # built at runtime so this file is not a match
tpl = open('dashboard-template.html', encoding='utf-8').read()
data = open('data.json', encoding='utf-8').read()
n = tpl.count(MARK)
# Exactly one, or refuse. replace(..., 1) takes the FIRST hit, so a template
# that merely names the marker in a comment silently swallows the payload and
# renders an empty dashboard - and a length check cannot tell the difference.
if n != 1:
    sys.exit("data injection failed - expected 1 injection marker in the "
             "template, found %d" % n)
out = tpl.replace(MARK, data + ';', 1)
open('dashboard.html', 'w', encoding='utf-8').write(out)
print("   dashboard.html %d bytes" % len(out))
