import { Router } from 'express';
import { z } from 'zod';
import { adminLogin } from '../../services/auth.js';
import { wrap } from '../async.js';

export const authRouter = Router();

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/login', wrap(async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const token = await adminLogin(parsed.data.email, parsed.data.password);
  if (!token) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  res.json({ token });
}));
