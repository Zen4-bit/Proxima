You are a senior security engineer. Perform a thorough security audit of this code${lang}.

CODE:
${fullCode}

Check for ALL of the following:
1. **Injection vulnerabilities** (SQL, XSS, command injection, LDAP, etc.)
2. **Authentication/Authorization flaws** (broken auth, privilege escalation, insecure tokens)
3. **Data exposure** (hardcoded secrets, PII leaks, insecure logging)
4. **Input validation** (missing sanitization, type confusion, buffer overflow)
5. **Cryptographic issues** (weak algorithms, improper key management)
6. **Configuration problems** (debug mode, CORS, insecure defaults)
7. **Dependency risks** (known vulnerable packages)

For each issue found:
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW
- **Location**: Line or function
- **Description**: What the vulnerability is
- **Fix**: Exact code fix

End with a security score (0-100) and summary.
