using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class MemScan2 {
    [StructLayout(LayoutKind.Sequential)]
    public struct MBI {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] public static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, int len);
    [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    public static long DumpAll(int pid, long maxRegion, string path) {
        IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
        if (h == IntPtr.Zero) throw new Exception("OpenProcess failed");
        IntPtr addr = IntPtr.Zero;
        var mbi = new MBI();
        int mbiSize = Marshal.SizeOf(typeof(MBI));
        byte[] buf = new byte[1 << 20];
        long total = 0;
        using (var fs = new System.IO.FileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.Write)) {
            while (VirtualQueryEx(h, addr, out mbi, mbiSize) != 0) {
                long size = mbi.RegionSize.ToInt64();
                bool readable = mbi.State == 0x1000 && (mbi.Protect == 0x02 || mbi.Protect == 0x04 || mbi.Protect == 0x20 || mbi.Protect == 0x40 || mbi.Protect == 0x08 || mbi.Protect == 0x80);
                if (readable && (mbi.Type == 0x20000 || mbi.Type == 0x40000) && size > 0 && size <= maxRegion) {
                    long offset = 0;
                    while (offset < size) {
                        int chunk = (int)Math.Min(buf.Length, size - offset);
                        IntPtr got;
                        if (ReadProcessMemory(h, IntPtr.Add(mbi.BaseAddress, (int)offset), buf, chunk, out got) && got.ToInt64() > 0) {
                            fs.Write(buf, 0, got.ToInt32());
                            total += got.ToInt64();
                        }
                        offset += chunk;
                    }
                }
                long next = mbi.BaseAddress.ToInt64() + size;
                if (next <= mbi.BaseAddress.ToInt64()) break;
                addr = new IntPtr(next);
            }
        }
        CloseHandle(h);
        return total;
    }

    public static byte[] ReadAt(int pid, long addr, int len) {
        IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
        if (h == IntPtr.Zero) return new byte[0];
        var buf = new byte[len];
        IntPtr got;
        bool ok = ReadProcessMemory(h, new IntPtr(addr), buf, len, out got);
        CloseHandle(h);
        if (!ok || got.ToInt64() != len) return new byte[0];
        return buf;
    }

    public static List<string> Contexts(int pid, long maxRegion, string needleHex, int maxHits) {
        var res = new List<string>();
        var b = new byte[needleHex.Length / 2];
        for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(needleHex.Substring(i * 2, 2), 16);
        string ns = Encoding.GetEncoding("ISO-8859-1").GetString(b);
        IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
        if (h == IntPtr.Zero) throw new Exception("OpenProcess failed");
        IntPtr addr = IntPtr.Zero;
        var mbi = new MBI();
        int mbiSize = Marshal.SizeOf(typeof(MBI));
        byte[] buf = new byte[1 << 20];
        while (VirtualQueryEx(h, addr, out mbi, mbiSize) != 0) {
            long size = mbi.RegionSize.ToInt64();
            bool readable = mbi.State == 0x1000 && (mbi.Protect == 0x02 || mbi.Protect == 0x04 || mbi.Protect == 0x20 || mbi.Protect == 0x40 || mbi.Protect == 0x08 || mbi.Protect == 0x80);
            if (readable && (mbi.Type == 0x20000 || mbi.Type == 0x1000000 || mbi.Type == 0x40000) && size > 0 && size <= maxRegion) {
                long offset = 0;
                while (offset < size) {
                    int chunk = (int)Math.Min(buf.Length, size - offset);
                    IntPtr got;
                    if (ReadProcessMemory(h, IntPtr.Add(mbi.BaseAddress, (int)offset), buf, chunk, out got) && got.ToInt64() > 0) {
                        int n = got.ToInt32();
                        string s = Encoding.GetEncoding("ISO-8859-1").GetString(buf, 0, n);
                        int idx = 0;
                        while ((idx = s.IndexOf(ns, idx, StringComparison.Ordinal)) >= 0) {
                            int st = Math.Max(0, idx - 64);
                            int en = Math.Min(n, idx + 80);
                            var sb = new StringBuilder();
                            sb.Append("hit@").Append(mbi.BaseAddress.ToInt64() + offset + idx).Append(" : ");
                            for (int k = st; k < en; k++) sb.Append(buf[k].ToString("x2"));
                            res.Add(sb.ToString());
                            if (res.Count >= maxHits) { CloseHandle(h); return res; }
                            idx += ns.Length;
                        }
                    }
                    if (chunk <= 512) break;
                    offset += chunk - 512;
                }
            }
            long next = mbi.BaseAddress.ToInt64() + size;
            if (next <= mbi.BaseAddress.ToInt64()) break;
            addr = new IntPtr(next);
        }
        CloseHandle(h);
        return res;
    }

    public static List<string> Scan(int pid, long maxRegion, string[] needlesHex) {
        var found = new HashSet<string>();
        var needles = new List<byte[]>();
        foreach (var nh in needlesHex) {
            var b = new byte[nh.Length / 2];
            for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(nh.Substring(i * 2, 2), 16);
            needles.Add(b);
        }
        IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
        if (h == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
        IntPtr addr = IntPtr.Zero;
        var mbi = new MBI();
        int mbiSize = Marshal.SizeOf(typeof(MBI));
        byte[] buf = new byte[1 << 20];
        int hits = 0;
        while (VirtualQueryEx(h, addr, out mbi, mbiSize) != 0) {
            long size = mbi.RegionSize.ToInt64();
            bool readable = mbi.State == 0x1000 && (mbi.Protect == 0x02 || mbi.Protect == 0x04 || mbi.Protect == 0x20 || mbi.Protect == 0x40 || mbi.Protect == 0x08 || mbi.Protect == 0x80);
            if (readable && (mbi.Type == 0x20000 || mbi.Type == 0x1000000 || mbi.Type == 0x40000) && size > 0 && size <= maxRegion) {
                long offset = 0;
                while (offset < size) {
                    int chunk = (int)Math.Min(buf.Length, size - offset);
                    IntPtr got;
                    if (ReadProcessMemory(h, IntPtr.Add(mbi.BaseAddress, (int)offset), buf, chunk, out got) && got.ToInt64() > 0) {
                        int n = got.ToInt32();
                        string s = Encoding.GetEncoding("ISO-8859-1").GetString(buf, 0, n);
                        foreach (var needle in needles) {
                            string ns = Encoding.GetEncoding("ISO-8859-1").GetString(needle);
                            int idx = 0;
                            while ((idx = s.IndexOf(ns, idx, StringComparison.Ordinal)) >= 0) {
                                hits++;
                                for (int off = -256; off <= 256; off += 1) {
                                    int st = idx + off;
                                    if (st < 0 || st + 32 > n) continue;
                                    var sb = new StringBuilder(64);
                                    for (int k = 0; k < 32; k++) sb.Append(buf[st + k].ToString("x2"));
                                    found.Add(sb.ToString());
                                }
                                idx += ns.Length;
                            }
                        }
                    }
                    if (chunk <= 512) break;
                    offset += chunk - 512;
                }
            }
            long next = mbi.BaseAddress.ToInt64() + size;
            if (next <= mbi.BaseAddress.ToInt64()) break;
            addr = new IntPtr(next);
        }
        CloseHandle(h);
        Console.WriteLine("salt hits: " + hits);
        return new List<string>(found);
    }
}