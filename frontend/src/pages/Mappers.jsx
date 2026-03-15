import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../context/AuthProvider.jsx';
import { useToast } from '../components/ui/toast.jsx';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Plus, Trash2, Pencil } from 'lucide-react';

export default function Mappers() {
  const { fetchWithAuth } = useAuth();
  const { toast } = useToast();
  const [mappers, setMappers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  useEffect(() => {
    fetchWithAuth('/api/mappers')
      .then((r) => r.json())
      .then((d) => setMappers(d.mappers ?? []))
      .catch(() => toast({ title: 'Failed to load mappers', variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, [fetchWithAuth, toast]);

  async function handleDelete(id) {
    if (!confirm('Delete this mapper?')) return;
    setDeleting(id);
    try {
      const res = await fetchWithAuth(`/api/mappers/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      setMappers((prev) => prev.filter((m) => m.id !== id));
      toast({ title: 'Mapper deleted' });
    } catch (err) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setDeleting(null);
    }
  }

  if (loading) return <p className="text-muted-foreground text-sm">Loading mappers…</p>;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: '#3d3672' }}>Mappers</h1>
          <p className="text-muted-foreground mt-1">Map integration fields to GoHighLevel values.</p>
        </div>
        <Button asChild className="text-white" style={{ backgroundColor: '#3d3672' }}>
          <Link to="/app/mappers/new">
            <Plus className="h-4 w-4" />
            New Mapper
          </Link>
        </Button>
      </div>

      {mappers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">No mappers configured yet.</p>
            <Button asChild className="mt-4" variant="outline" style={{ borderColor: '#1b7895', color: '#1b7895' }}>
              <Link to="/app/mappers/new">Create your first mapper</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base" style={{ color: '#3d3672' }}>
              {mappers.length} mapper{mappers.length !== 1 ? 's' : ''}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b" style={{ backgroundColor: '#dbeaff' }}>
                  <tr>
                    <th className="px-6 py-3 text-left font-medium" style={{ color: '#3d3672' }}>App</th>
                    <th className="px-6 py-3 text-left font-medium" style={{ color: '#3d3672' }}>Type</th>
                    <th className="px-6 py-3 text-left font-medium" style={{ color: '#3d3672' }}>External Key</th>
                    <th className="px-6 py-3 text-left font-medium" style={{ color: '#3d3672' }}>GHL Value</th>
                    <th className="px-6 py-3 text-right font-medium" style={{ color: '#3d3672' }}>Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {mappers.map((m) => (
                    <tr key={m.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-6 py-4">
                        <Badge variant="secondary">{m.appSlug}</Badge>
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">{m.mapperType}</td>
                      <td className="px-6 py-4 font-mono text-xs">{m.externalKey}</td>
                      <td className="px-6 py-4 font-mono text-xs">{m.ghlValue}</td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button asChild variant="ghost" size="icon">
                            <Link to={`/app/mappers/${m.id}`}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            disabled={deleting === m.id}
                            onClick={() => handleDelete(m.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
